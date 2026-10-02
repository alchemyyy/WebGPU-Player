// worker-loader always emits the custom decode worker as [name].[contenthash].bundle.js
const CUSTOM_DECODE_WORKER_ASSET_PATTERN =
    /^CustomDecode\.worker\.[a-f0-9]{8,64}\.bundle\.js$/u;

/** Selects exactly one content-addressed custom decode worker. */
export function selectCustomDecodeWorkerAssetName(fileNames) {
    if (!Array.isArray(fileNames) || fileNames.some(fileName => typeof fileName !== 'string')) {
        throw new TypeError('Worker artifact file names must be a string array');
    }
    const contentAddressedMatches = [];
    for (const fileName of fileNames) {
        if (CUSTOM_DECODE_WORKER_ASSET_PATTERN.test(fileName)) {
            contentAddressedMatches.push(fileName);
        }
    }
    return contentAddressedMatches.length === 1 ? contentAddressedMatches[0] : null;
}
