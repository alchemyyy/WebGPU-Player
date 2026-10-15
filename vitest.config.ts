/// <reference types="vitest" />
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import LAYOUT from './tools/constants.json';

export default defineConfig({
    plugins: [ tsconfigPaths() ],
    test: {
        environment: 'jsdom',
        // The engine's tests, and each decoder project's own beside its sources
        include: [ `${LAYOUT.testDirectory}/**/*.test.ts`, `${LAYOUT.decodersDirectory}/*/test/**/*.test.ts` ],
        restoreMocks: true
    }
});
