/// <reference types="vitest" />
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import LAYOUT from './tools/constants.json';

export default defineConfig({
    plugins: [ tsconfigPaths() ],
    test: {
        environment: 'jsdom',
        include: [ `${LAYOUT.testDirectory}/**/*.test.ts` ],
        restoreMocks: true
    }
});
