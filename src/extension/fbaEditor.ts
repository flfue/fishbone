/**
 * copyright (c) 2020, Matthias Behr
 *
 * todo:
 * change to "request-light" (npm i request-light) for https requests
 * - add nonce/random ids to each element? (for smaller edits/updates)
 * - add feature on reset to reload the "nested" rootcauses with relPath
 */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { getNonce, performHttpRequest } from './util';
import * as yaml from 'js-yaml';
import TelemetryReporter from 'vscode-extension-telemetry';

interface AssetManifest {
    files: {
        'main.js': string;
        'main.css': string;
        'runtime-main.js': string;
        [key: string]: string;
    };
}

/**
 * 
 */
export class FBAEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {

    public static register(context: vscode.ExtensionContext, reporter?: TelemetryReporter): vscode.Disposable {
        const provider = new FBAEditorProvider(context, reporter);
        const providerRegistration = vscode.window.registerCustomEditorProvider(FBAEditorProvider.viewType, provider);

        // todo was only for testing. add later with e.g. nr errors, or unchecked ...
        // context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));

        return providerRegistration;
    }

    private static readonly viewType = 'fishbone.fba'; // has to match the package.json
    private _subscriptions: Array<vscode.Disposable> = new Array<vscode.Disposable>();

    /// some extensions might offer a rest api (currently only dlt-logs), store ext name and function here
    private _restQueryExtFunctions: Map<string, Function> = new Map<string, Function>();
    private _checkExtensionsTimer?: NodeJS.Timeout = undefined;
    private _checkExtensionsLastActive = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly reporter?: TelemetryReporter
    ) {
        console.log(`FBAEditorProvider constructor() called...`);

        // time-sync feature: check other extensions for api onDidChangeSelectedTime and connect to them.
        this._subscriptions.push(vscode.extensions.onDidChange(() => {
            setTimeout(() => {
                console.log(`fishbone.extensions.onDidChange #ext=${vscode.extensions.all.length}`);
                this.checkActiveExtensions();
            }, 1500);
        }));
        this._checkExtensionsTimer = setInterval(() => {
            this.checkActiveExtensions();
        }, 1000);
        /* setTimeout(() => {
            this.checkActiveExtensions();
        }, 2000); todo renable one the onDidChange works reliable... */
    }

    dispose() {
        console.log(`FBAEditorProvider dispose() called...`);

        if (this._checkExtensionsTimer) {
            clearInterval(this._checkExtensionsTimer);
            this._checkExtensionsTimer = undefined;
        }

        this._subscriptions.forEach((value) => {
            if (value !== undefined) {
                value.dispose();
            }
        });
    }

    checkActiveExtensions() {

        // we debounce and react only if the number of active extensions changes:
        let nrActiveExt = vscode.extensions.all.reduce((acc, cur) => acc + (cur.isActive ? 1 : 0), 0);
        if (nrActiveExt !== this._checkExtensionsLastActive) {
            this._checkExtensionsLastActive = nrActiveExt;
            // no need to dispose them.
            this._restQueryExtFunctions.clear();
            let newRQs = new Map<string, Function>();

            vscode.extensions.all.forEach((value) => {
                if (value.isActive) {
                    // console.log(`dlt-log:found active extension: id=${value.id}`);// with #exports=${value.exports.length}`);
                    try {
                        let importedApi = value.exports;
                        if (importedApi !== undefined) {
                            let subscr = importedApi.restQuery;
                            if (subscr !== undefined) {
                                console.log(`fishbone.got restQuery api from ${value.id}`);
                                // testing it:
                                console.log(`fishbone restQuery('/get/version')=${subscr('/get/version')}`);
                                newRQs.set(value.id, subscr);
                            }
                        }
                    } catch (error) {
                        console.log(`fishbone: extension ${value.id} throws: ${error}`);
                    }
                }
            });
            this._restQueryExtFunctions = newRQs;
            console.log(`fishbone.checkActiveExtensions: got ${this._restQueryExtFunctions.size} rest query functions.`);
        } else {
            // console.log(`fishbone.checkActiveExtensions: nrActiveExt = ${nrActiveExt}`);
        }
    }

    /**
     * Called when our custom editor is opened.
     */
    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {

        this.reporter?.sendTelemetryEvent("resolveCustomTextEditor", undefined, { 'lineCount': document.lineCount });

        // Setup initial content for the webview
        webviewPanel.webview.options = {
            enableScripts: true,
        };
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // the panel can only receive data once fully loaded.
        // So we do wait for the panel to send an alive
        // then we'll send our data:

        let docData: { gotAliveFromPanel: boolean, msgsToPost: any[] } = {
            gotAliveFromPanel: false,
            msgsToPost: []
        };

        function postMsgOnceAlive(msg: any) {
            if (docData.gotAliveFromPanel) { // send instantly
                const msgCmd = msg.command;
                webviewPanel.webview.postMessage(msg); /*.then((onFulFilled) => {
                    console.log(`WebsharkView.postMessage(${msgCmd}) direct ${onFulFilled}`);
                });*/
            } else {
                docData.msgsToPost.push(msg);
            }
        };

        function updateWebview() {
            console.log(`updateWebview called`);

            const docObj: any = FBAEditorProvider.getFBDataFromDoc(document);

            postMsgOnceAlive({
                type: 'update',
                data: docObj.fishbone,
                title: docObj.title,
                attributes: docObj.attributes
            });
        }

        // Hook up event handlers so that we can synchronize the webview with the text document.
        //
        // The text document acts as our model, so we have to sync change in the document to our
        // editor and sync changes in the editor back to the document.
        // 
        // Remember that a single text document can also be shared between multiple custom
        // editors (this happens for example when you split a custom editor)

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                updateWebview();
            }
        });

        // Make sure we get rid of the listener when our editor is closed.
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });

        // Receive message from the webview.

        webviewPanel.webview.onDidReceiveMessage(e => {
            docData.gotAliveFromPanel = true;
            // any messages to post?
            if (docData.msgsToPost.length) {
                let msg: any;
                while (msg = docData.msgsToPost.pop()) {
                    const msgCmd = JSON.stringify(msg);
                    webviewPanel.webview.postMessage(msg); /*.then((onFulFilled) => {
                        console.log(`WebsharkView.postMessage(${msgCmd}) queued ${onFulFilled}`);
                    });*/
                }
            }

            switch (e.type) {
                case 'update':
                    try {
                        FBAEditorProvider.updateTextDocument(document, { fishbone: e.data, title: e.title, attributes: e.attributes })?.then((fulfilled) => {
                            console.log(`updateTextDocument fulfilled=${fulfilled}`);
                        }); // same as update webview
                    } catch (e) {
                        vscode.window.showErrorMessage(`Fishbone: Could not update document. Changes are lost. Please consider closing and reopening the doc. Error= ${e}.`);
                    }
                    break;
                case 'sAr':
                    {  // vscode.postMessage({ type: 'sAr', req: req, id: reqId });
                        console.log(`fbaEditor got sAr msg(id=${e.id}}): ${JSON.stringify(e.req)}`);
                        switch (e.req.type) {
                            case 'restQuery':
                                { // {"type":"restQuery","request":"ext:dlt-logs/get/sw-versions"}
                                    const url: string = typeof e.req.request === 'string' ? e.req.request : e.req.request.url;
                                    if (url.startsWith('ext:')) {

                                        const extName = url.slice(4, url.indexOf('/'));
                                        const query = url.slice(url.indexOf('/'));
                                        console.log(`extName=${extName} request=${url}`);
                                        // did this extension offer the restQuery?
                                        const rq = this._restQueryExtFunctions.get(extName);
                                        if (rq) {
                                            // call it:
                                            const res = rq(query);
                                            console.log(`restQuery response='${res}'`);
                                            // todo try/catch
                                            webviewPanel.webview.postMessage({ type: e.type, res: JSON.parse(res), id: e.id });
                                        } else {
                                            webviewPanel.webview.postMessage({ type: e.type, res: { errors: [`extName '${extName}' does not offer restQuery (yet?)`] }, id: e.id });
                                        }
                                    } else {
                                        const requestObj: any = typeof e.req.request === 'object' ? e.req.request : undefined;
                                        console.log(`triggerRestQuery triggering ${JSON.stringify(e.req.request)} via request`);

                                        performHttpRequest(this.context.globalState, url, { 'Accept': 'application/json' }).then((result: any) => {
                                            console.log(`request statsCode=${result.res.statusCode}`);
                                            const json = JSON.parse(result.body);
                                            webviewPanel.webview.postMessage({ type: e.type, res: json, id: e.id });
                                        }).catch(err => {
                                            webviewPanel.webview.postMessage({ type: e.type, res: { errors: [`request failed with err=${err}`] }, id: e.id });
                                        });
                                    }
                                }
                                break;
                            default:
                                console.warn(`fbaEditor got unknown sAr type '${e.req.type}'`);
                                webviewPanel.webview.postMessage({ type: e.type, res: { errors: [`unknown sAr type '${e.req.type}'`] }, id: e.id });
                                break;
                        }
                    }
                    break;
                case 'log':
                    console.log(e.message);
                    return;
                default:
                    console.log(`FBAEditorProvider.onDidReceiveMessage e=${JSON.stringify(e)}`);
                    break;
            }
        });

        updateWebview();
    }

    /**
     * Get the static html used for the editor webviews.
     */

    private getHtmlForWebview(webview: vscode.Webview): string {

        const webviewPath: string = path.join(this.context.extensionPath, 'out', 'webview');
        const assetManifest: AssetManifest = require(path.join(webviewPath, 'asset-manifest.json'));

        const main: string = assetManifest.files['main.js'];
        const styles: string = assetManifest.files['main.css'];
        const runTime: string = assetManifest.files['runtime-main.js'];
        const chunk: string = Object.keys(assetManifest.files).find((key) => key.endsWith('chunk.js')) as string;

        const mainUri: vscode.Uri = vscode.Uri.file(path.join(webviewPath, main)).with({ scheme: 'vscode-resource' });
        const stylesUri: vscode.Uri = vscode.Uri.file(path.join(webviewPath, styles)).with({ scheme: 'vscode-resource' });
        const runTimeMainUri: vscode.Uri = vscode.Uri.file(path.join(webviewPath, runTime)).with({ scheme: 'vscode-resource' });
        const chunkUri: vscode.Uri = vscode.Uri.file(path.join(webviewPath, chunk)).with({ scheme: 'vscode-resource' });

        // Use a nonce to whitelist which scripts can be run
        const nonce = getNonce();
        // todo 				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

        const initialData: any[] = [];
        const initialDataStr = JSON.stringify(initialData);

        return /* html */`
			<!DOCTYPE html>
			<html lang="en">
			<head>
                <meta charset="UTF-8">
                <meta name="theme-color" content="#000000" />

				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
				-->

				<meta name="viewport" content="width=device-width, initial-scale=0.5">

				<link href="${stylesUri.toString(true)}" rel="stylesheet" />

                <title>Fishbone Analysis</title>
			</head>
            <body>
                <noscript>You need to enable JavaScript to run this app.</noscript>
                <script nonce="${nonce}">
                    console.log('in initial script');
                    window.acquireVsCodeApi = acquireVsCodeApi;
                    window.initialData = ${initialDataStr};
                </script>
                <div id="root"></div>
                <script nonce="${nonce}" crossorigin="anonymous" src="${runTimeMainUri.toString(true)}"></script>
                <script nonce="${nonce}" crossorigin="anonymous" src="${chunkUri.toString(true)}"></script>
                <script nonce="${nonce}" crossorigin="anonymous" src="${mainUri.toString(true)}"></script>
			</body>
			</html>`;
    }

    /**
     * Write out the object to a given document.
     */
    static async updateTextDocument(document: vscode.TextDocument, docObj: any) {
        console.log(`updateTextDocument called with json.keys=${Object.keys(docObj)}`);
        Object.keys(docObj).forEach(key => {
            console.log(` ${key}=${JSON.stringify(docObj[key])}`);
        });

        const edit = new vscode.WorkspaceEdit();

        // Just replace the entire text document every time for now.
        let yamlObj: any = {};
        try {
            yamlObj = yaml.safeLoad(document.getText()); // JSON.parse(document.getText());
            if (typeof yamlObj !== 'object') {
                console.error('Could not get document as json. Content is not valid yamlObj ' + JSON.stringify(yamlObj));
                yamlObj = {};
            }
        } catch (e) {
            console.error('Could not get document as json. Content is not valid yaml e= ' + e);
        }

        // only 'title', 'attributes' and 'fishbone' are updated for now. keep the rest:
        if ('version' in docObj) { yamlObj.version = docObj.version; } else {
            if (!('version' in yamlObj)) { yamlObj.version = '0.3'; } // todo const somewhere..
        }

        if ('title' in docObj) { yamlObj.title = docObj.title; }
        if (('attributes' in docObj) && docObj.attributes !== undefined) { yamlObj.attributes = docObj.attributes; }
        if ('fishbone' in docObj) {
            // special command handling to import other fishbones:
            const deepRootCausesForEach = async (fishbone: any[], fn: (rc: any) => any | null | undefined) => {
                for (const effect of fishbone) {
                    const nrCats = effect?.categories?.length;
                    if (nrCats > 0) {
                        for (let c = 0; c < nrCats; ++c) {
                            const category = effect.categories[c];
                            let nrRcs = category?.rootCauses?.length;
                            if (nrRcs > 0) {
                                for (let r = 0; r < nrRcs; ++r) {
                                    const rc = category.rootCauses[r];
                                    let modRc = await fn(rc); // we call the callback in any case
                                    if (modRc === undefined) { // no change
                                        modRc = rc;
                                    } else if (modRc === null) { // delete this rc.
                                        category.rootCauses.splice(r, 1);
                                        --nrRcs;
                                        modRc = undefined;
                                    } else { // update
                                        category.rootCauses[r] = modRc;
                                    }
                                    if (modRc !== undefined) {
                                        // and if its a nested we do nest automatically:
                                        if (modRc?.type === 'nested') {
                                            deepRootCausesForEach(modRc.data, fn);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            };
            // check for root causes type "import"
            // we do return 
            //  null: -> rc will be deleted
            //  modified obj -> will replace rc
            //  undefined -> no change
            await deepRootCausesForEach(docObj.fishbone, async (rc) => {
                if (rc?.type === 'import') {
                    console.warn(`got 'import' rc:`, rc);
                    // show open file dialog:
                    const uri = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Fishbone': ['fba'] }, openLabel: 'import', title: 'select fishbone to import' });
                    if (uri && uri.length === 1) {
                        console.warn(`shall import '${uri[0].toString()}'`);
                        // determine relative path and store for later update
                        const relPath = path.relative(document.uri.fsPath, uri[0].fsPath);
                        console.log(`got relPath='${relPath}' from '${document.uri.fsPath}' and '${uri[0].fsPath}'`);
                        try {
                            const fileText = fs.readFileSync(uri[0].fsPath, { encoding: 'utf8' });
                            const importYamlObj = FBAEditorProvider.getFBDataFromText(fileText, undefined);
                            if (typeof importYamlObj === 'object') {
                                // merge attributes (we might consider adding the new ones to the nested only and show only on entering that nested one?)
                                FBAEditorProvider.mergeAttributes(yamlObj.attributes, importYamlObj.attributes);
                                return {
                                    type: 'nested',
                                    relPath: relPath,
                                    title: importYamlObj.title,
                                    data: importYamlObj.fishbone
                                };
                            }
                        } catch (e) {
                            console.error(`opening file failed with err:'${e}'`);
                        }
                    }
                    return null; // delete the import rc
                }
                return undefined;
            });

            yamlObj.fishbone = docObj.fishbone;
        }

        // now store it as yaml:
        try {
            const yamlStr = yaml.safeDump(yamlObj);

    /*console.log(`new yaml text=
    ${yamlStr}
    `);*/

            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                yamlStr);

        } catch (e) {
            console.error(`storing as YAML failed. Error=${e}`);
            return;
        }
        return vscode.workspace.applyEdit(edit);
    }

    static getFBDataFromText(text: string, updateFn: undefined | ((yamlObj: any) => void)) {
        // here we do return the data that we pass as data=... to the Fishbone

        // our document is a yaml document. 
        // representing a single object with properties:
        //  type <- expect "fba"
        //  version <- 0.3
        //  fishbone : array of effect objects

        try {
            let yamlObj: any = undefined;
            if (text.trim().length === 0) {
                yamlObj = {
                    type: 'fba',
                    version: '0.3',
                    title: '<no title>',
                    fishbone: [
                        {
                            name: "<enter effect to analyse>",
                            categories: [
                                {
                                    name: 'category 1',
                                    rootCauses: []
                                }
                            ]
                        }
                    ],
                    attributes: []
                };
            } else {
                yamlObj = yaml.safeLoad(text); // JSON.parse(text);
            }
            if (typeof yamlObj !== 'object') { throw new Error(`content is no 'object' but '${typeof yamlObj}'`); }
            console.log(`getFBDataFromText type=${yamlObj.type}, version=${yamlObj.version}`);
            console.log(`getFBDataFromText title=${yamlObj.title}`);

            // convert data from prev. versions?
            const convertv01Effects = (effects: any) => {
                return effects.map((effectsPair: any) => {
                    return {
                        name: effectsPair[0],
                        categories: effectsPair[1].map((catPair: any) => {
                            return {
                                name: catPair[0],
                                rootCauses: catPair[1].map((rootCause: any) => {
                                    if (typeof rootCause === 'object' && rootCause.type === 'nested') {
                                        const newRootCause = { ...rootCause };
                                        newRootCause.data = convertv01Effects(rootCause.data);
                                        return newRootCause;
                                    } else {
                                        return rootCause;
                                    }
                                })
                            };
                        })
                    };
                });
            };

            // convert data from prev. version 0.2
            const convertv02TextFields = (effects: any) => {
                return effects.map((effectsPair: any) => {
                    return effectsPair.categories.map((category: any) => {
                        return category.rootCauses.map((rootCause: any) => {

                            // Recursively updating nested fishbone diagrams below
                            if (typeof rootCause === 'object' && rootCause.type === 'nested') {
                                convertv02TextFields(rootCause.data);
                            }

                            // Updating fields
                            if (rootCause.props && typeof rootCause.props.instructions === 'string') {
                                rootCause.props.instructions = { textValue: rootCause.props.instructions };
                            }
                            if (rootCause.props && typeof rootCause.props.backgroundDescription === 'string') {
                                rootCause.props.backgroundDescription = { textValue: rootCause.props.backgroundDescription };
                            }
                            if (rootCause.props && typeof rootCause.props.comments === 'string') {
                                rootCause.props.comments = { textValue: rootCause.props.comments };
                            }
                        });
                    });
                });
            };

            // convert from prev. known formats:
            if (yamlObj?.version === '0.1') {
                // the effects storage has changed:
                if (yamlObj.fishbone) {
                    const fbv02 = convertv01Effects(yamlObj.fishbone);
                    console.log(`fbv02=`, fbv02);
                    yamlObj.fishbone = fbv02;
                }
                yamlObj.version = '0.2';
                if (updateFn !== undefined) { updateFn(yamlObj); }
            }

            // convert from prev. known formats:
            if (yamlObj?.version === '0.2') {
                // the instruction, background and comment field has changed from string to object:
                if (yamlObj.fishbone) {
                    convertv02TextFields(yamlObj.fishbone);
                    console.log(`fbv03=`, yamlObj.fishbone);
                }
                yamlObj.version = '0.3';
                if (updateFn !== undefined) { updateFn(yamlObj); }
            }


            // we're not forwards compatible. 
            if (yamlObj?.version !== '0.3') {
                const msg = `Fishbone: The document uses unknown version ${yamlObj?.version}. Please check whether an extension update is available.`;
                throw new Error(msg);
            }

            return { attributes: yamlObj?.attributes, fishbone: yamlObj.fishbone, title: yamlObj.title || '<please add title to .fba>' };
        } catch (e) {
            vscode.window.showErrorMessage(`Fishbone: Could not get document as yaml. Content is not valid yaml. Error= ${e}`);
            throw new Error('Could not get document as yaml. Content is not valid yaml e= ' + e);
        }
        return { title: '<error>' };
    }

    /**
     * Parse the documents content into an object.
     */
    static getFBDataFromDoc(doc: vscode.TextDocument): any {
        const text = doc.getText();

        return FBAEditorProvider.getFBDataFromText(text, (yamlObj) => {
            FBAEditorProvider.updateTextDocument(doc, yamlObj);
        });
    }

    /**
     * merge attributes from newAttrs into mainAttrs.
     * The rules are:
     *  an attribute not existing in mainAttrs will simply be added to mainAttrs
     *  an attribute already existing is ignored, even though parameters
     *  might be different!
     * @param mainAttrs 
     * @param newAttrs 
     */
    static mergeAttributes(mainAttrs: any[], newAttrs: any[] | undefined) {
        console.warn(`FBAEditorProvider.mergeAttributes mainAttrs=${JSON.stringify(mainAttrs)} newAttrs=${JSON.stringify(newAttrs)}`);
        // attributes are arrays of objects with a single key (the name)
        if (newAttrs === undefined) { return; }
        const mainKeys = mainAttrs.map(a => Object.keys(a)[0]);
        for (const newKeyObj of newAttrs) {
            const newKey = Object.keys(newKeyObj)[0];
            if (!mainKeys.includes(newKey)) {
                mainAttrs.push(newKeyObj);
            }
        }
    }

    provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.FileDecoration | undefined {
        console.warn(`FBAEditorProvider.provideFileDecoration(uri=${uri.toString()})...`);
        if (uri.toString().endsWith('.fba')) {
            console.warn(` FBAEditorProvider.provideFileDecoration returning a test FileDecoration`);
            return {
                badge: "42", // max 2 digits
                tooltip: "fba contains 42 errors", color: new vscode.ThemeColor('errorForeground'), propagate: true
            };
        }
        return undefined;
    }
}