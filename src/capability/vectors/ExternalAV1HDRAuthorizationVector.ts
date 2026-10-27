import { decodeBase64 } from './Base64';
import type { ExternalHDRAuthorizationVectorSample } from './ExternalHDRAuthorizationVector';

export const EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_VERSION = 1;
export const EXTERNAL_AV1_HDR_AUTHORIZATION_CODEC = 'av01.0.08M.10';
export const EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_WIDTH = 1_920;
export const EXTERNAL_AV1_HDR_AUTHORIZATION_CODED_HEIGHT = 1_080;
export const EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_WIDTH = 1_920;
export const EXTERNAL_AV1_HDR_AUTHORIZATION_DISPLAY_HEIGHT = 1_080;
export const EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SHA256 = 'ac9297441a37c5fc19653d56a721d5a21d4b34dd3fc56890343c29edbe442ae1';

/** The center of each 256x256 patch and its exact 10-bit codes, in a mid-gray picture */
export const EXTERNAL_AV1_HDR_AUTHORIZATION_VECTOR_SAMPLES: readonly ExternalHDRAuthorizationVectorSample[] = [{
    rawYUVCode: [ 64, 512, 512 ],
    sampleX: 240,
    sampleY: 272
}, {
    rawYUVCode: [ 283, 512, 512 ],
    sampleX: 720,
    sampleY: 272
}, {
    rawYUVCode: [ 503, 512, 512 ],
    sampleX: 1_200,
    sampleY: 272
}, {
    rawYUVCode: [ 722, 512, 512 ],
    sampleX: 1_680,
    sampleY: 272
}, {
    rawYUVCode: [ 940, 512, 512 ],
    sampleX: 240,
    sampleY: 808
}, {
    rawYUVCode: [ 525, 612, 412 ],
    sampleX: 720,
    sampleY: 808
}, {
    rawYUVCode: [ 705, 412, 612 ],
    sampleX: 1_200,
    sampleY: 808
}, {
    rawYUVCode: [ 780, 412, 612 ],
    sampleX: 1_680,
    sampleY: 808
}];

// One temporal unit of AV1 Main, 10-bit 4:2:0, limited BT.2020/PQ, from the pinned FFmpeg: a yuv420p10le picture of code 400 gray with a 256x256 patch of each sample's codes around it,
// tagged by setparams and coded by libaom-av1 with -cpu-used 4 -aom-params lossless=1, so every sample decodes to its exact codes
const EXTERNAL_AV1_HDR_AUTHORIZATION_TEMPORAL_UNIT_BASE64 = [
    'EgAKDgAAAEKrv8N3a+dCRAJBMv0CEACAAAAAZOT4L0y////mul5m5j2g+fpauHkJgNL8HJleefDUjDxxQq62ezllS08vn5nqnhhh',
    'skFj1pkUD5fFm1EPWv7SVkcZfZIEo9/Ynu71Gf1WXVi9v6XvugyqHuGZiteq++RcCG9vOpVbeRHgZ9oudv2DbOerfrFzR2+p0mWZ',
    'mXun+G1yAmfb8cqQzpDvxa+2WhKtvTi73/63qjeDeKPSVP7RfUU8paUNwG7fvkrS0t+GNTalbMpsXlVeIVXMoRe39uk9AVbrPCiQ',
    'fCqFfICX99F/FwZ95ZLfo+v7fGro6q7/k5Wb1POS+Yt7J1Mpa591Pub8JZ0TJ/4zxFISEqnOKYVF7bPtOTvU2MMWmNdXFyKOFke3',
    '2x8sbh0oLeK9sooXBlhO7visPVfJEJ880rNODQRdw9mHLGvgKgVirdneQ3kzmLSAz2fU/2UnDGCYzHg49t6/pzL+HxYhIoAC6dqX',
    'OUc6i4wBO1yqX+DTuAOjtwNjreJ9bC0JJGzg'
].join('');

/** Returns a new copy of the temporal unit, as coded, for native AV1 HDR transport authorization. */
export function createExternalAV1HDRAuthorizationTemporalUnit(): Uint8Array {
    return decodeBase64(EXTERNAL_AV1_HDR_AUTHORIZATION_TEMPORAL_UNIT_BASE64);
}
