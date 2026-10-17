/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import LAYOUT from './tools/constants.json';

export default defineConfig({
    plugins: [ tsconfigPaths() ],
    test: {
        environment: 'jsdom',
        // The engine's tests, and each decoder project's own beside its sources
        include: [ `${LAYOUT.testDirectory}/**/*.test.ts`, `${LAYOUT.decodersDirectory}/*/test/**/*.test.ts` ],
        // Every test starts from fresh mocks: restoreMocks restores vi.spyOn spies, and mockReset clears each mock's calls and resets its implementation
        mockReset: true,
        restoreMocks: true
    }
});
