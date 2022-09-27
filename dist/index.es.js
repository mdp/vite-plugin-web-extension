import { normalizePath, createFilter } from 'vite';
import path from 'path';
import crypto from 'crypto';
import { emptyDir, copy, writeFile, readFile, ensureDir, readFileSync } from 'fs-extra';
import parse from 'content-security-policy-parser';
import getEtag from 'etag';
import MagicString from 'magic-string';

function getNormalizedFileName(fileName, includeExt = true) {
    let { dir, name, ext } = path.parse(normalizePath(path.normalize(fileName)));
    if (!dir) {
        return `${name}${includeExt ? ext : ""}`;
    }
    dir = dir.startsWith("/") ? dir.slice(1) : dir;
    return `${dir}/${name}${includeExt ? ext : ""}`;
}
function getInputFileName(inputFileName, root) {
    return `${root}/${getNormalizedFileName(inputFileName, true)}`;
}
function getOutputFileName(inputFileName) {
    return getNormalizedFileName(inputFileName, false);
}
function isSingleHtmlFilename(fileName) {
    return /[^*]+.html$/.test(fileName);
}

function addInputScriptsToOptionsInput(inputScripts, optionsInput) {
    const optionsInputObject = getOptionsInputAsObject(optionsInput);
    inputScripts.forEach(([output, input]) => (optionsInputObject[output] = input));
    return optionsInputObject;
}
function getOptionsInputAsObject(input) {
    if (typeof input === "string") {
        if (!input.trim()) {
            return {};
        }
        return {
            [input]: input,
        };
    }
    else if (input instanceof Array) {
        if (!input.length) {
            return {};
        }
        const inputObject = {};
        input.forEach((input) => (inputObject[input] = input));
        return inputObject;
    }
    return input !== null && input !== void 0 ? input : {};
}
function getChunkInfoFromBundle(bundle, chunkId) {
    const normalizedId = getNormalizedFileName(chunkId);
    return Object.values(bundle).find((chunk) => {
        var _a;
        if (chunk.type === "asset") {
            return false;
        }
        return (((_a = chunk.facadeModuleId) === null || _a === void 0 ? void 0 : _a.endsWith(normalizedId)) ||
            chunk.fileName.endsWith(normalizedId));
    });
}

function getScriptHtmlLoaderFile(name, scriptSrcs) {
    const scriptsHtml = scriptSrcs
        .map((scriptSrc) => {
        return `<script type="module" src="${scriptSrc}"></script>`;
    })
        .join("");
    return {
        fileName: `${name}.html`,
        source: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />${scriptsHtml}</head></html>`,
    };
}
function getScriptLoaderFile(scriptFileName, outputChunkFileName) {
    const outputFile = getOutputFileName(scriptFileName);
    const importPath = outputChunkFileName.startsWith("http")
        ? `'${outputChunkFileName}'`
        : `chrome.runtime.getURL("${outputChunkFileName}")`;
    return {
        fileName: `${outputFile}.js`,
        source: `(async()=>{await import(${importPath})})();`,
    };
}
function getServiceWorkerLoaderFile(serviceWorkerFileName) {
    const importPath = serviceWorkerFileName.startsWith("http")
        ? `${serviceWorkerFileName}`
        : `/${serviceWorkerFileName}`;
    return {
        fileName: `serviceWorker.js`,
        source: `import "${importPath}";`,
    };
}
function getContentScriptLoaderForOutputChunk(contentScriptFileName, chunk) {
    if (!chunk.imports.length && !chunk.dynamicImports.length) {
        return {
            fileName: chunk.fileName,
        };
    }
    return getScriptLoaderFile(contentScriptFileName, chunk.fileName);
}
function getWebAccessibleScriptLoaderForOutputChunk(contentScriptFileName, chunk) {
    return getScriptLoaderFile(contentScriptFileName, chunk.fileName);
}

const virtualModules = new Map();
function setVirtualModule(id, source) {
    virtualModules.set(id, source);
}
function getVirtualModule(id) {
    var _a;
    return (_a = virtualModules.get(id)) !== null && _a !== void 0 ? _a : null;
}

const addHmrSupportToCsp = (hmrServerOrigin, inlineScriptHashes, contentSecurityPolicyStr) => {
    const inlineScriptHashesArr = Array.from(inlineScriptHashes);
    const scriptSrcs = ["'self'", hmrServerOrigin].concat(inlineScriptHashesArr || []);
    const contentSecurityPolicy = parse(contentSecurityPolicyStr || "");
    contentSecurityPolicy["script-src"] = scriptSrcs.concat(contentSecurityPolicy["script-src"]);
    contentSecurityPolicy["object-src"] = ["'self'"].concat(contentSecurityPolicy["object-src"]);
    return Object.keys(contentSecurityPolicy)
        .map((key) => {
        return (`${key} ` +
            contentSecurityPolicy[key]
                .filter((c, idx) => contentSecurityPolicy[key].indexOf(c) === idx) // Dedupe
                .join(" "));
    })
        .join("; ");
};

class DevBuilder {
    constructor(viteConfig, pluginExtras, viteDevServer) {
        this.viteConfig = viteConfig;
        this.pluginExtras = pluginExtras;
        this.viteDevServer = viteDevServer;
        this.hmrServerOrigin = "";
        this.inlineScriptHashes = new Set();
        this.outDir = this.viteConfig.build.outDir;
    }
    async writeBuild({ devServerPort, manifest, manifestHtmlFiles, }) {
        this.hmrServerOrigin = this.getHmrServerOrigin(devServerPort);
        await emptyDir(this.outDir);
        copy("public", this.outDir);
        await this.writeManifestHtmlFiles(manifestHtmlFiles);
        await this.writeManifestContentScriptFiles(manifest);
        await this.writeManifestWebAccessibleScriptFiles(manifest, this.pluginExtras.webAccessibleScriptsFilter);
        await this.writeBuildFiles(manifest, manifestHtmlFiles);
        this.updateContentSecurityPolicyForHmr(manifest);
        await writeFile(`${this.outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
    }
    async writeBuildFiles(_manifest, _manifestHtmlFiles) { }
    getContentSecurityPolicyWithHmrSupport(contentSecurityPolicy) {
        return addHmrSupportToCsp(this.hmrServerOrigin, this.inlineScriptHashes, contentSecurityPolicy);
    }
    async writeManifestHtmlFiles(htmlFileNames) {
        for (const fileName of htmlFileNames) {
            const absoluteFileName = getInputFileName(fileName, this.viteConfig.root);
            await this.writeManifestHtmlFile(fileName, absoluteFileName);
            this.viteDevServer.watcher.on("change", async (path) => {
                if (normalizePath(path) !== absoluteFileName) {
                    return;
                }
                await this.writeManifestHtmlFile(fileName, absoluteFileName);
            });
        }
    }
    async writeManifestHtmlFile(fileName, absoluteFileName) {
        var _a;
        let content = (_a = getVirtualModule(absoluteFileName)) !== null && _a !== void 0 ? _a : (await readFile(absoluteFileName, {
            encoding: "utf-8",
        }));
        // apply plugin transforms
        content = await this.viteDevServer.transformIndexHtml(fileName, content);
        // update root paths
        content = content.replace(/src="\//g, `src="${this.hmrServerOrigin}/`);
        content = content.replace(/from "\//g, `from "${this.hmrServerOrigin}/`);
        // update relative paths
        const inputFileDir = path.dirname(fileName);
        content = content.replace(/src="\.\//g, `src="${this.hmrServerOrigin}/${inputFileDir ? `${inputFileDir}/` : ""}`);
        this.parseInlineScriptHashes(content);
        const outFile = `${this.outDir}/${fileName}`;
        const outFileDir = path.dirname(outFile);
        await ensureDir(outFileDir);
        await writeFile(outFile, content);
    }
    parseInlineScriptHashes(_content) { }
    async writeManifestContentScriptFiles(manifest) {
        if (!manifest.content_scripts) {
            return;
        }
        for (const [contentScriptIndex, script,] of manifest.content_scripts.entries()) {
            if (!script.js) {
                continue;
            }
            for (const [scriptJsIndex, fileName] of script.js.entries()) {
                const outputFileName = getOutputFileName(fileName);
                const scriptLoaderFile = getScriptLoaderFile(outputFileName, `${this.hmrServerOrigin}/${fileName}`);
                manifest.content_scripts[contentScriptIndex].js[scriptJsIndex] =
                    scriptLoaderFile.fileName;
                const outFile = `${this.outDir}/${scriptLoaderFile.fileName}`;
                const outFileDir = path.dirname(outFile);
                await ensureDir(outFileDir);
                await writeFile(outFile, scriptLoaderFile.source);
            }
        }
    }
    getHmrServerOrigin(devServerPort) {
        if (typeof this.viteConfig.server.hmr === "boolean") {
            throw new Error("Vite HMR is misconfigured");
        }
        return `http://${this.viteConfig.server.hmr.host}:${devServerPort}`;
    }
}

class DevBuilderManifestV2 extends DevBuilder {
    updateContentSecurityPolicyForHmr(manifest) {
        manifest.content_security_policy =
            this.getContentSecurityPolicyWithHmrSupport(manifest.content_security_policy);
        return manifest;
    }
    parseInlineScriptHashes(content) {
        const matches = content.matchAll(/<script.*?>([^<]+)<\/script>/gs);
        for (const match of matches) {
            const shasum = crypto.createHash("sha256");
            shasum.update(match[1]);
            this.inlineScriptHashes.add(`'sha256-${shasum.digest("base64")}'`);
        }
    }
    async writeManifestWebAccessibleScriptFiles(manifest, webAccessibleScriptsFilter) {
        if (!manifest.web_accessible_resources) {
            return;
        }
        for (const [webAccessibleResourceIndex, resourceFileName,] of manifest.web_accessible_resources.entries()) {
            if (!resourceFileName) {
                continue;
            }
            if (!webAccessibleScriptsFilter(resourceFileName))
                continue;
            const outputFileName = getOutputFileName(resourceFileName);
            const scriptLoaderFile = getScriptLoaderFile(outputFileName, `${this.hmrServerOrigin}/${resourceFileName}`);
            manifest.web_accessible_resources[webAccessibleResourceIndex] =
                scriptLoaderFile.fileName;
            const outFile = `${this.outDir}/${scriptLoaderFile.fileName}`;
            const outFileDir = path.dirname(outFile);
            await ensureDir(outFileDir);
            await writeFile(outFile, scriptLoaderFile.source);
        }
    }
}

class ManifestParser {
    constructor(inputManifest, pluginExtras, viteConfig) {
        this.inputManifest = inputManifest;
        this.pluginExtras = pluginExtras;
        this.viteConfig = viteConfig;
    }
    async parseInput() {
        const parseResult = {
            manifest: this.inputManifest,
            inputScripts: [],
            emitFiles: [],
        };
        return this.pipe(parseResult, this.parseInputHtmlFiles, this.parseInputContentScripts, this.parseInputWebAccessibleScripts, ...this.getParseInputMethods());
    }
    async writeDevBuild(devServerPort) {
        await this.createDevBuilder().writeBuild({
            devServerPort,
            manifest: this.inputManifest,
            manifestHtmlFiles: this.getHtmlFileNames(this.inputManifest),
        });
    }
    async parseOutput(bundle) {
        let result = {
            inputScripts: [],
            emitFiles: [],
            manifest: this.inputManifest,
        };
        result = await this.parseOutputWebAccessibleScripts(result, bundle);
        result = await this.parseOutputContentScripts(result, bundle);
        for (const parseMethod of this.getParseOutputMethods()) {
            result = await parseMethod(result, bundle);
        }
        result.emitFiles.push({
            type: "asset",
            fileName: "manifest.json",
            source: JSON.stringify(result.manifest, null, 2),
        });
        return result;
    }
    setDevServer(server) {
        this.viteDevServer = server;
    }
    parseInputHtmlFiles(result) {
        this.getHtmlFileNames(result.manifest).forEach((htmlFileName) => this.parseInputHtmlFile(htmlFileName, result));
        return result;
    }
    parseInputContentScripts(result) {
        var _a;
        (_a = result.manifest.content_scripts) === null || _a === void 0 ? void 0 : _a.forEach((script) => {
            var _a, _b;
            (_a = script.js) === null || _a === void 0 ? void 0 : _a.forEach((scriptFile) => {
                const inputFile = getInputFileName(scriptFile, this.viteConfig.root);
                const outputFile = getOutputFileName(scriptFile);
                result.inputScripts.push([outputFile, inputFile]);
            });
            (_b = script.css) === null || _b === void 0 ? void 0 : _b.forEach((cssFile) => {
                result.emitFiles.push({
                    type: "asset",
                    fileName: cssFile,
                    source: readFileSync(cssFile, "utf-8"),
                });
            });
        });
        return result;
    }
    parseInputHtmlFile(htmlFileName, result) {
        if (!htmlFileName) {
            return result;
        }
        const inputFile = getInputFileName(htmlFileName, this.viteConfig.root);
        const outputFile = getOutputFileName(htmlFileName);
        result.inputScripts.push([outputFile, inputFile]);
        return result;
    }
    parseOutputContentScript(scriptFileName, result, bundle) {
        const chunkInfo = getChunkInfoFromBundle(bundle, scriptFileName);
        if (!chunkInfo) {
            throw new Error(`Failed to find chunk info for ${scriptFileName}`);
        }
        const scriptLoaderFile = getContentScriptLoaderForOutputChunk(scriptFileName, chunkInfo);
        if (scriptLoaderFile.source) {
            result.emitFiles.push({
                type: "asset",
                fileName: scriptLoaderFile.fileName,
                source: scriptLoaderFile.source,
            });
        }
        const metadata = this.getMetadataforChunk(chunkInfo.fileName, bundle, Boolean(scriptLoaderFile.source));
        chunkInfo.code = chunkInfo.code.replace(new RegExp("import.meta.PLUGIN_WEB_EXT_CHUNK_CSS_PATHS", "g"), `[${[...metadata.css].map((path) => `"${path}"`).join(",")}]`);
        return {
            scriptFileName: scriptLoaderFile.fileName,
            webAccessibleFiles: new Set([...metadata.assets, ...metadata.css]),
        };
    }
    parseOutputWebAccessibleScript(scriptFileName, result, bundle) {
        const chunkInfo = getChunkInfoFromBundle(bundle, scriptFileName);
        if (!chunkInfo) {
            throw new Error(`Failed to find chunk info for ${scriptFileName}`);
        }
        const scriptLoaderFile = getWebAccessibleScriptLoaderForOutputChunk(scriptFileName, chunkInfo);
        if (scriptLoaderFile.source) {
            result.emitFiles.push({
                type: "asset",
                fileName: scriptLoaderFile.fileName,
                source: scriptLoaderFile.source,
            });
        }
        const metadata = this.getMetadataforChunk(chunkInfo.fileName, bundle, Boolean(scriptLoaderFile.source));
        chunkInfo.code = chunkInfo.code.replace(new RegExp("import.meta.PLUGIN_WEB_EXT_CHUNK_CSS_PATHS", "g"), `[${[...metadata.css].map((path) => `"${path}"`).join(",")}]`);
        return {
            scriptFileName: scriptLoaderFile.fileName,
            webAccessibleFiles: new Set([...metadata.assets, ...metadata.css]),
        };
    }
    pipe(initialValue, ...fns) {
        return fns.reduce((previousValue, fn) => fn.call(this, previousValue), initialValue);
    }
    getMetadataforChunk(chunkId, bundle, includeChunkAsAsset, metadata = {
        css: new Set(),
        assets: new Set(),
    }) {
        const chunkInfo = getChunkInfoFromBundle(bundle, chunkId);
        if (!chunkInfo) {
            return metadata;
        }
        if (includeChunkAsAsset) {
            metadata.assets.add(chunkInfo.fileName);
        }
        chunkInfo.viteMetadata.importedCss.forEach(metadata.css.add, metadata.css);
        chunkInfo.viteMetadata.importedAssets.forEach(metadata.assets.add, metadata.assets);
        chunkInfo.imports.forEach((chunkId) => (metadata = this.getMetadataforChunk(chunkId, bundle, true, metadata)));
        chunkInfo.dynamicImports.forEach((chunkId) => (metadata = this.getMetadataforChunk(chunkId, bundle, true, metadata)));
        return metadata;
    }
}

class ManifestV2 extends ManifestParser {
    createDevBuilder() {
        return new DevBuilderManifestV2(this.viteConfig, this.pluginExtras, this.viteDevServer);
    }
    getHtmlFileNames(manifest) {
        var _a, _b, _c, _d, _e, _f, _g;
        return [
            (_a = manifest.background) === null || _a === void 0 ? void 0 : _a.page,
            (_b = manifest.browser_action) === null || _b === void 0 ? void 0 : _b.default_popup,
            (_c = manifest.options_ui) === null || _c === void 0 ? void 0 : _c.page,
            manifest.devtools_page,
            (_d = manifest.chrome_url_overrides) === null || _d === void 0 ? void 0 : _d.newtab,
            (_e = manifest.chrome_url_overrides) === null || _e === void 0 ? void 0 : _e.history,
            (_f = manifest.chrome_url_overrides) === null || _f === void 0 ? void 0 : _f.bookmarks,
            ...((_g = manifest.web_accessible_resources) !== null && _g !== void 0 ? _g : []).filter(isSingleHtmlFilename),
        ].filter((fileName) => typeof fileName === "string");
    }
    getParseInputMethods() {
        return [this.parseInputBackgroundScripts];
    }
    getParseOutputMethods() {
        return [this.parseWatchModeSupport.bind(this)];
    }
    parseInputBackgroundScripts(result) {
        var _a;
        if (!((_a = result.manifest.background) === null || _a === void 0 ? void 0 : _a.scripts)) {
            return result;
        }
        const htmlLoaderFile = getScriptHtmlLoaderFile("background", result.manifest.background.scripts.map((script) => {
            if (/^[\.\/]/.test(script)) {
                return script;
            }
            return `/${script}`;
        }));
        const inputFile = getInputFileName(htmlLoaderFile.fileName, this.viteConfig.root);
        const outputFile = getOutputFileName(htmlLoaderFile.fileName);
        result.inputScripts.push([outputFile, inputFile]);
        setVirtualModule(inputFile, htmlLoaderFile.source);
        delete result.manifest.background.scripts;
        result.manifest.background.page = htmlLoaderFile.fileName;
        return result;
    }
    parseInputWebAccessibleScripts(result) {
        var _a;
        (_a = result.manifest.web_accessible_resources) === null || _a === void 0 ? void 0 : _a.forEach((resource) => {
            if (resource.includes("*"))
                return;
            const inputFile = getInputFileName(resource, this.viteConfig.root);
            const outputFile = getOutputFileName(resource);
            if (this.pluginExtras.webAccessibleScriptsFilter(inputFile)) {
                result.inputScripts.push([outputFile, inputFile]);
            }
        });
        return result;
    }
    async parseOutputContentScripts(result, bundle) {
        var _a, _b;
        const webAccessibleResources = new Set((_a = result.manifest.web_accessible_resources) !== null && _a !== void 0 ? _a : []);
        (_b = result.manifest.content_scripts) === null || _b === void 0 ? void 0 : _b.forEach((script) => {
            var _a;
            (_a = script.js) === null || _a === void 0 ? void 0 : _a.forEach((scriptFileName, index) => {
                const parsedContentScript = this.parseOutputContentScript(scriptFileName, result, bundle);
                script.js[index] = parsedContentScript.scriptFileName;
                parsedContentScript.webAccessibleFiles.forEach(webAccessibleResources.add, webAccessibleResources);
            });
        });
        if (webAccessibleResources.size > 0) {
            result.manifest.web_accessible_resources = Array.from(webAccessibleResources);
        }
        return result;
    }
    async parseOutputWebAccessibleScripts(result, bundle) {
        if (!result.manifest.web_accessible_resources) {
            return result;
        }
        for (const resource of result.manifest.web_accessible_resources) {
            if (resource.includes("*") ||
                !this.pluginExtras.webAccessibleScriptsFilter(resource)) {
                continue;
            }
            const parsedContentScript = this.parseOutputWebAccessibleScript(resource, result, bundle);
            result.manifest.web_accessible_resources = [
                ...result.manifest.web_accessible_resources,
                ...parsedContentScript.webAccessibleFiles,
            ];
        }
        return result;
    }
    async parseWatchModeSupport(result) {
        if (!result.manifest.web_accessible_resources) {
            return result;
        }
        if (result.manifest.web_accessible_resources.length > 0 &&
            this.viteConfig.build.watch) {
            // expose all files in watch mode to allow web-ext reloading to work when manifest changes are not applied on reload (eg. Firefox)
            result.manifest.web_accessible_resources.push("*.js");
        }
        return result;
    }
}

class DevBuilderManifestV3 extends DevBuilder {
    async writeBuildFiles(manifest) {
        await this.writeManifestServiceWorkerFiles(manifest);
    }
    updateContentSecurityPolicyForHmr(manifest) {
        var _a;
        (_a = manifest.content_security_policy) !== null && _a !== void 0 ? _a : (manifest.content_security_policy = {});
        manifest.content_security_policy.extension_pages =
            this.getContentSecurityPolicyWithHmrSupport(manifest.content_security_policy.extension_pages);
        return manifest;
    }
    async writeManifestServiceWorkerFiles(manifest) {
        var _a, _b;
        if (!((_a = manifest.background) === null || _a === void 0 ? void 0 : _a.service_worker)) {
            return;
        }
        const fileName = (_b = manifest.background) === null || _b === void 0 ? void 0 : _b.service_worker;
        const serviceWorkerLoader = getServiceWorkerLoaderFile(`${this.hmrServerOrigin}/${fileName}`);
        manifest.background.service_worker = serviceWorkerLoader.fileName;
        const outFile = `${this.outDir}/${serviceWorkerLoader.fileName}`;
        const outFileDir = path.dirname(outFile);
        await ensureDir(outFileDir);
        await writeFile(outFile, serviceWorkerLoader.source);
    }
    async writeManifestWebAccessibleScriptFiles(manifest, webAccessibleScriptsFilter) {
        if (!manifest.web_accessible_resources) {
            return;
        }
        for (const [webAccessibleResourceIndex, struct,] of manifest.web_accessible_resources.entries()) {
            if (!struct || !struct.resources.length) {
                continue;
            }
            for (const [scriptJsIndex, fileName] of struct.resources.entries()) {
                if (!webAccessibleScriptsFilter(fileName))
                    continue;
                const outputFileName = getOutputFileName(fileName);
                const scriptLoaderFile = getScriptLoaderFile(outputFileName, `${this.hmrServerOrigin}/${fileName}`);
                manifest.web_accessible_resources[webAccessibleResourceIndex].resources[scriptJsIndex] = scriptLoaderFile.fileName;
                const outFile = `${this.outDir}/${scriptLoaderFile.fileName}`;
                const outFileDir = path.dirname(outFile);
                await ensureDir(outFileDir);
                await writeFile(outFile, scriptLoaderFile.source);
            }
        }
    }
}

class ManifestV3 extends ManifestParser {
    createDevBuilder() {
        return new DevBuilderManifestV3(this.viteConfig, this.pluginExtras, this.viteDevServer);
    }
    getHtmlFileNames(manifest) {
        var _a, _b, _c, _d, _e, _f;
        const webAccessibleResourcesHtmlFileNames = [];
        ((_a = manifest.web_accessible_resources) !== null && _a !== void 0 ? _a : []).forEach(({ resources }) => resources.filter(isSingleHtmlFilename).forEach((html) => {
            webAccessibleResourcesHtmlFileNames.push(html);
        }));
        return [
            (_b = manifest.action) === null || _b === void 0 ? void 0 : _b.default_popup,
            (_c = manifest.options_ui) === null || _c === void 0 ? void 0 : _c.page,
            manifest.devtools_page,
            (_d = manifest.chrome_url_overrides) === null || _d === void 0 ? void 0 : _d.newtab,
            (_e = manifest.chrome_url_overrides) === null || _e === void 0 ? void 0 : _e.history,
            (_f = manifest.chrome_url_overrides) === null || _f === void 0 ? void 0 : _f.bookmarks,
            ...webAccessibleResourcesHtmlFileNames,
        ].filter((fileName) => typeof fileName === "string");
    }
    getParseInputMethods() {
        return [this.parseInputBackgroundServiceWorker];
    }
    getParseOutputMethods() {
        return [this.parseOutputServiceWorker];
    }
    parseInputBackgroundServiceWorker(result) {
        var _a, _b;
        if (!((_a = result.manifest.background) === null || _a === void 0 ? void 0 : _a.service_worker)) {
            return result;
        }
        const serviceWorkerScript = (_b = result.manifest.background) === null || _b === void 0 ? void 0 : _b.service_worker;
        const inputFile = getInputFileName(serviceWorkerScript, this.viteConfig.root);
        const outputFile = getOutputFileName(serviceWorkerScript);
        result.inputScripts.push([outputFile, inputFile]);
        result.manifest.background.type = "module";
        return result;
    }
    parseInputWebAccessibleScripts(result) {
        var _a;
        (_a = result.manifest.web_accessible_resources) === null || _a === void 0 ? void 0 : _a.forEach((struct) => {
            struct.resources.forEach((resource) => {
                if (resource.includes("*"))
                    return;
                const inputFile = getInputFileName(resource, this.viteConfig.root);
                const outputFile = getOutputFileName(resource);
                if (this.pluginExtras.webAccessibleScriptsFilter(inputFile)) {
                    result.inputScripts.push([outputFile, inputFile]);
                }
            });
        });
        return result;
    }
    async parseOutputContentScripts(result, bundle) {
        var _a, _b;
        const webAccessibleResources = new Set([...((_a = result.manifest.web_accessible_resources) !== null && _a !== void 0 ? _a : [])]);
        (_b = result.manifest.content_scripts) === null || _b === void 0 ? void 0 : _b.forEach((script) => {
            var _a;
            (_a = script.js) === null || _a === void 0 ? void 0 : _a.forEach((scriptFileName, index) => {
                const parsedContentScript = this.parseOutputContentScript(scriptFileName, result, bundle);
                script.js[index] = parsedContentScript.scriptFileName;
                if (parsedContentScript.webAccessibleFiles.size) {
                    webAccessibleResources.add({
                        resources: Array.from(parsedContentScript.webAccessibleFiles),
                        matches: script.matches.map((matchPattern) => {
                            const pathMatch = /[^:\/]\//.exec(matchPattern);
                            if (!pathMatch) {
                                return matchPattern;
                            }
                            const path = matchPattern.slice(pathMatch.index + 1);
                            if (["/", "/*"].includes(path)) {
                                return matchPattern;
                            }
                            return matchPattern.replace(path, "/*");
                        }),
                        // @ts-ignore - use_dynamic_url is a newly supported option
                        use_dynamic_url: true,
                    });
                }
            });
        });
        if (webAccessibleResources.size > 0) {
            result.manifest.web_accessible_resources = Array.from(webAccessibleResources);
        }
        return result;
    }
    async parseOutputWebAccessibleScripts(result, bundle) {
        if (!result.manifest.web_accessible_resources) {
            return result;
        }
        for (const resource of result.manifest.web_accessible_resources) {
            if (!resource.resources) {
                continue;
            }
            for (const fileName of resource.resources) {
                if (fileName.includes("*") ||
                    !this.pluginExtras.webAccessibleScriptsFilter(fileName)) {
                    continue;
                }
                const parsedScript = this.parseOutputWebAccessibleScript(fileName, result, bundle);
                if (parsedScript.webAccessibleFiles.size) {
                    resource.resources = [
                        ...resource.resources,
                        ...parsedScript.webAccessibleFiles,
                    ];
                }
            }
        }
        return result;
    }
    async parseOutputServiceWorker(result, bundle) {
        var _a;
        const serviceWorkerFileName = (_a = result.manifest.background) === null || _a === void 0 ? void 0 : _a.service_worker;
        if (!serviceWorkerFileName) {
            return result;
        }
        const chunkInfo = getChunkInfoFromBundle(bundle, serviceWorkerFileName);
        if (!chunkInfo) {
            throw new Error(`Failed to find chunk info for ${serviceWorkerFileName}`);
        }
        const serviceWorkerLoader = getServiceWorkerLoaderFile(chunkInfo.fileName);
        result.manifest.background.service_worker = serviceWorkerLoader.fileName;
        result.emitFiles.push({
            type: "asset",
            fileName: serviceWorkerLoader.fileName,
            source: serviceWorkerLoader.source,
        });
        return result;
    }
}

class ManifestParserFactory {
    static getParser(manifest, pluginExtras, viteConfig) {
        var _a;
        switch (manifest.manifest_version) {
            case 2:
                return new ManifestV2(manifest, pluginExtras, viteConfig);
            case 3:
                return new ManifestV3(manifest, pluginExtras, viteConfig);
            default:
                throw new Error(`No parser available for manifest_version ${
                // @ts-expect-error - Allow showing manifest version for invalid usage
                (_a = manifest.manifest_version) !== null && _a !== void 0 ? _a : 0}`);
        }
    }
}

// Hack in support for changing the injection location of styles
//  Needed to support HMR styles in shadow DOM rendered content
//  Also supports multiple content script shadow DOMs rendered on the same page
const contentScriptStyleHandler = (req, res, next) => {
    const _originalEnd = res.end;
    // @ts-ignore
    res.end = function end(chunk, ...otherArgs) {
        if (req.url === "/@vite/client" && typeof chunk === "string") {
            if (!/const sheetsMap/.test(chunk) ||
                !/document\.head\.appendChild\(style\)/.test(chunk) ||
                !/document\.head\.removeChild\(style\)/.test(chunk) ||
                !/style\.innerHTML = content/.test(chunk)) {
                console.error("Content script HMR style support disabled -- failed to rewrite vite client");
                res.setHeader("Etag", getEtag(chunk, { weak: true }));
                // @ts-ignore
                return _originalEnd.call(this, chunk, ...otherArgs);
            }
            chunk = chunk.replace("const sheetsMap", "const styleTargets = new Set(); const styleTargetsStyleMap = new Map(); const sheetsMap");
            chunk = chunk.replace("export {", "export { addStyleTarget, ");
            chunk = chunk.replace("document.head.appendChild(style)", "styleTargets.size ? styleTargets.forEach(target => addStyleToTarget(style, target)) : document.head.appendChild(style)");
            chunk = chunk.replace("document.head.removeChild(style)", "styleTargetsStyleMap.get(style) ? styleTargetsStyleMap.get(style).forEach(style => style.parentNode.removeChild(style)) : document.head.removeChild(style)");
            const lastStyleInnerHtml = chunk.lastIndexOf("style.innerHTML = content");
            chunk =
                chunk.slice(0, lastStyleInnerHtml) +
                    chunk
                        .slice(lastStyleInnerHtml)
                        .replace("style.innerHTML = content", "style.innerHTML = content; styleTargetsStyleMap.get(style)?.forEach(style => style.innerHTML = content)");
            chunk += `
        function addStyleTarget(newStyleTarget) {            
          for (const [, style] of sheetsMap.entries()) {
            addStyleToTarget(style, newStyleTarget, styleTargets.size !== 0);
          }

          styleTargets.add(newStyleTarget);
        }

        function addStyleToTarget(style, target, cloneStyle = true) {
          const addedStyle = cloneStyle ? style.cloneNode(true) : style;
          target.appendChild(addedStyle);

          styleTargetsStyleMap.set(style, [...(styleTargetsStyleMap.get(style) ?? []), addedStyle]);
        }
      `;
            res.setHeader("Etag", getEtag(chunk, { weak: true }));
        }
        // @ts-ignore
        return _originalEnd.call(this, chunk, ...otherArgs);
    };
    next();
};

// Update vite user config with settings necessary for the plugin to work
function updateConfigForExtensionSupport(config, manifest) {
    var _a, _b, _c, _d, _e, _f;
    var _g, _h;
    (_a = config.build) !== null && _a !== void 0 ? _a : (config.build = {});
    if (!config.build.target) {
        switch (manifest.manifest_version) {
            case 2:
                config.build.target = ["chrome64", "firefox89"]; // minimum browsers with import.meta.url and content script dynamic import
                break;
            case 3:
                config.build.target = ["chrome91"];
                break;
        }
    }
    (_b = (_g = config.build).rollupOptions) !== null && _b !== void 0 ? _b : (_g.rollupOptions = {});
    (_c = (_h = config.build.rollupOptions).input) !== null && _c !== void 0 ? _c : (_h.input = {});
    (_d = config.optimizeDeps) !== null && _d !== void 0 ? _d : (config.optimizeDeps = {});
    config.optimizeDeps.exclude = [
        ...((_e = config.optimizeDeps.exclude) !== null && _e !== void 0 ? _e : []),
        "/@vite/client",
    ];
    (_f = config.server) !== null && _f !== void 0 ? _f : (config.server = {});
    if (config.server.hmr === true || !config.server.hmr) {
        config.server.hmr = {};
    }
    config.server.hmr.protocol = "ws"; // required for content script hmr to work on https
    config.server.hmr.host = "localhost";
    return config;
}
// Vite asset helper rewrites usages of import.meta.url to self.location for broader
//   browser support, but content scripts need to reference assets via import.meta.url
// This transform rewrites self.location back to import.meta.url
function transformSelfLocationAssets(code, resolvedViteConfig) {
    if (code.includes("new URL") && code.includes(`self.location`)) {
        let updatedCode = null;
        const selfLocationUrlPattern = /\bnew\s+URL\s*\(\s*('[^']+'|"[^"]+"|`[^`]+`)\s*,\s*self\.location\s*\)/g;
        let match;
        while ((match = selfLocationUrlPattern.exec(code))) {
            const { 0: exp, index } = match;
            if (!updatedCode)
                updatedCode = new MagicString(code);
            updatedCode.overwrite(index, index + exp.length, exp.replace("self.location", "import.meta.url"));
        }
        if (updatedCode) {
            return {
                code: updatedCode.toString(),
                map: resolvedViteConfig.build.sourcemap
                    ? updatedCode.generateMap({ hires: true })
                    : null,
            };
        }
    }
    return null;
}

function webExtension(pluginOptions) {
    if (!pluginOptions.manifest) {
        throw new Error("Missing manifest definition");
    }
    let viteConfig;
    let emitQueue = [];
    let manifestParser;
    const webConfig = pluginOptions.webAccessibleScripts;
    let webAccessibleScriptsFilter = createFilter((webConfig === null || webConfig === void 0 ? void 0 : webConfig.include) || /\.([cem]?js|ts)$/, (webConfig === null || webConfig === void 0 ? void 0 : webConfig.exclude) || "", webConfig === null || webConfig === void 0 ? void 0 : webConfig.options);
    return {
        name: "webExtension",
        enforce: "post",
        config(config) {
            return updateConfigForExtensionSupport(config, pluginOptions.manifest);
        },
        configResolved(resolvedConfig) {
            viteConfig = resolvedConfig;
        },
        configureServer(server) {
            server.middlewares.use(contentScriptStyleHandler);
            server.httpServer.once("listening", () => {
                manifestParser.setDevServer(server);
                manifestParser.writeDevBuild(server.config.server.port);
            });
        },
        async options(options) {
            manifestParser = ManifestParserFactory.getParser(JSON.parse(JSON.stringify(pluginOptions.manifest)), { webAccessibleScriptsFilter }, viteConfig);
            const { inputScripts, emitFiles } = await manifestParser.parseInput();
            options.input = addInputScriptsToOptionsInput(inputScripts, options.input);
            emitQueue = emitQueue.concat(emitFiles);
            return options;
        },
        buildStart() {
            emitQueue.forEach((file) => {
                var _a;
                this.emitFile(file);
                this.addWatchFile((_a = file.fileName) !== null && _a !== void 0 ? _a : file.name);
            });
            emitQueue = [];
        },
        renderDynamicImport() {
            return {
                left: "import((chrome != null ? chrome : browser).runtime.getURL(",
                right: "))",
            };
        },
        resolveId(id) {
            return getVirtualModule(id) ? id : null;
        },
        load(id) {
            return getVirtualModule(id);
        },
        transform(code) {
            return transformSelfLocationAssets(code, viteConfig);
        },
        async generateBundle(_options, bundle) {
            const { emitFiles } = await manifestParser.parseOutput(bundle);
            emitFiles.forEach(this.emitFile);
        },
    };
}

export { webExtension as default };
