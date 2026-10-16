// Reads the pass files of the pass projects in wgpup/, which the asset build copies into bin/wgpup/ for hosts to offer
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PASS_FILE_EXTENSION } from 'webgpu-player/presentation/passes/PassLanguage';

import { PASSES_DIRECTORY } from './enginePaths';

/** One pass file: the project that holds it, its file name, and its source. */
export type PostprocessingPassFile = Readonly<{
    fileName: string
    project: string
    source: string
}>;

/** Reads one pass file of a pass project. */
export function readPostprocessingPass(project: string, fileName: string): string {
    return readFileSync(join(PASSES_DIRECTORY, project, fileName), 'utf8');
}

function compareNames(first: string, second: string): number {
    return first.localeCompare(second);
}

/** Reads every pass file, a WGSL file at a project's top level, as the asset build copies them, in project then file name order. */
export function readPostprocessingPasses(): PostprocessingPassFile[] {
    const passes: PostprocessingPassFile[] = [];
    const projects = readdirSync(PASSES_DIRECTORY, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort(compareNames);
    for (const project of projects) {
        const fileNames = readdirSync(join(PASSES_DIRECTORY, project), { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith(PASS_FILE_EXTENSION))
            .map(entry => entry.name)
            .sort(compareNames);
        for (const fileName of fileNames) {
            passes.push({ fileName, project, source: readPostprocessingPass(project, fileName) });
        }
    }
    return passes;
}
