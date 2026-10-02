// @ts-check

// Adapted from Jellyfin Web's configuration, which also lints src/ and test/ when this engine is its submodule.
// Keep the plugins, browserslist, and polyfills aligned so both configurations accept the same directives.

import eslint from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import compat from 'eslint-plugin-compat';
import globals from 'globals';
// @ts-expect-error Missing type definition
import importPlugin from 'eslint-plugin-import';
import restrictedGlobals from 'confusing-browser-globals';
import sonarjs from 'eslint-plugin-sonarjs';
import stylistic from '@stylistic/eslint-plugin';
// eslint-disable-next-line import/no-unresolved
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    // @ts-expect-error Harmless type mismatch in dependency
    comments.recommended,
    compat.configs['flat/recommended'],
    importPlugin.flatConfigs.errors,
    sonarjs.configs.recommended,

    // Global ignores
    {
        ignores: [
            'node_modules',
            'coverage',
            'dist',
            'codecs/build',
            'codecs/dist',
            'codecs/external',
            'codecs/libdovi/target',
            'tools/playback-smoke-media'
        ]
    },

    // Global style rules
    {
        plugins: {
            '@stylistic': stylistic
        },
        extends: [ importPlugin.flatConfigs.typescript ],
        rules: {
            'array-callback-return': ['error', { 'checkForEach': true }],
            'curly': ['error', 'multi-line', 'consistent'],
            'default-case-last': 'error',
            // Tests import engine modules through the tsconfig path alias, which tsc checks
            'import/no-unresolved': ['error', { 'ignore': ['^webgpu-player/'] }],
            'max-params': ['error', 7],
            'new-cap': [
                'error',
                {
                    'newIsCapExceptionPattern': String.raw`\.default$`
                }
            ],
            'no-duplicate-imports': 'error',
            'no-empty-function': 'error',
            'no-extend-native': 'error',
            'no-lonely-if': 'error',
            'no-nested-ternary': 'error',
            'no-redeclare': 'off',
            '@typescript-eslint/no-redeclare': ['error', { builtinGlobals: false }],
            'no-restricted-globals': ['error'].concat(restrictedGlobals),
            'no-restricted-properties': [
                'error',
                {
                    property: 'replaceChildren',
                    message: 'replaceChildren is not supported in all target browsers'
                }
            ],
            'no-return-assign': 'error',
            'no-return-await': 'error',
            'no-sequences': ['error', { 'allowInParentheses': false }],
            'no-shadow': 'off',
            '@typescript-eslint/no-shadow': 'error',
            'no-throw-literal': 'error',
            'no-undef-init': 'error',
            'no-unneeded-ternary': 'error',
            'no-unused-expressions': 'off',
            '@typescript-eslint/no-unused-expressions': ['error', { 'allowShortCircuit': true, 'allowTernary': true, 'allowTaggedTemplates': true }],
            'no-unused-private-class-members': 'error',
            '@typescript-eslint/no-unused-vars': 'error',
            'no-useless-rename': 'error',
            'no-useless-constructor': 'off',
            '@typescript-eslint/no-useless-constructor': 'error',
            'no-var': 'error',
            'no-void': ['error', { 'allowAsStatement': true }],
            'one-var': ['error', 'never'],
            'prefer-const': ['error', { 'destructuring': 'all' }],
            'prefer-promise-reject-errors': ['warn', { 'allowEmptyReject': true }],
            '@typescript-eslint/prefer-for-of': 'error',
            'radix': 'error',
            'yoda': 'error',

            'sonarjs/fixme-tag': 'warn',
            'sonarjs/todo-tag': 'off',
            'sonarjs/deprecation': 'off',
            'sonarjs/no-alphabetical-sort': 'warn',
            'sonarjs/no-inverted-boolean-check': 'error',
            'sonarjs/no-selector-parameter': 'off',
            'sonarjs/pseudo-random': 'warn',
            'sonarjs/aws-restricted-ip-admin-access': 'off',
            'sonarjs/no-duplicate-string': 'off',
            'sonarjs/no-nested-functions': 'warn',
            // NOTE: This rule throws `TypeError: secretSignatures[fqn].forEach is not a function`
            'sonarjs/hardcoded-secret-signatures': 'off',

            '@stylistic/block-spacing': 'error',
            '@stylistic/brace-style': ['error', '1tbs', { 'allowSingleLine': true }],
            '@stylistic/comma-dangle': ['error', 'never'],
            '@stylistic/comma-spacing': 'error',
            '@stylistic/eol-last': 'error',
            '@stylistic/indent': ['error', 4, { 'SwitchCase': 1 }],
            '@stylistic/keyword-spacing': 'error',
            '@stylistic/max-statements-per-line': 'error',
            '@stylistic/no-floating-decimal': 'error',
            '@stylistic/no-mixed-spaces-and-tabs': 'error',
            '@stylistic/no-multi-spaces': 'error',
            '@stylistic/no-multiple-empty-lines': ['error', { 'max': 1 }],
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/object-curly-spacing': ['error', 'always'],
            '@stylistic/operator-linebreak': ['error', 'before', { overrides: { '?': 'after', ':': 'after', '=': 'after' } }],
            '@stylistic/padded-blocks': ['error', 'never'],
            '@stylistic/quotes': ['error', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': false }],
            '@stylistic/semi': 'error',
            '@stylistic/space-before-blocks': 'error',
            '@stylistic/space-infix-ops': 'error'
        }
    },

    // Build scripts and tools run on Node, so browser compatibility does not apply
    // NOTE: Directory patterns need /** here, because ignores beside other keys match file paths
    {
        ignores: [ 'src/**', 'test/**' ],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'compat/compat': 'off'
        }
    },

    // Engine sources and tests
    {
        files: [
            'src/**/*.ts',
            'test/**/*.ts'
        ],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            },
            globals: {
                ...globals.browser
            }
        },
        settings: {
            'import/resolver': {
                node: {
                    extensions: [
                        '.js',
                        '.ts'
                    ]
                }
            },
            // Jellyfin Web's polyfills, which hosts are expected to provide
            polyfills: [
                // Hosts transpile and polyfill ES APIs; inside Jellyfin Web the plugin infers this from its babel config
                'es:all',
                'Promise',
                'fetch',
                'Response',
                'Response.headers',
                'Response.json',
                'document.registerElement',
                'TextEncoder',
                'IntersectionObserver',
                'Object.assign',
                'Object.is',
                'Object.setPrototypeOf',
                'Object.toString',
                'Object.freeze',
                'Object.seal',
                'Object.preventExtensions',
                'Object.isFrozen',
                'Object.isSealed',
                'Object.isExtensible',
                'Object.getOwnPropertyDescriptor',
                'Object.getPrototypeOf',
                'Object.keys',
                'Object.entries',
                'Object.getOwnPropertyNames',
                'Function.name',
                'Function.hasInstance',
                'Array.from',
                'Array.arrayOf',
                'Array.copyWithin',
                'Array.fill',
                'Array.find',
                'Array.findIndex',
                'Array.iterator',
                'String.fromCodePoint',
                'String.raw',
                'String.iterator',
                'String.codePointAt',
                'String.endsWith',
                'String.includes',
                'String.repeat',
                'String.startsWith',
                'String.trim',
                'String.anchor',
                'String.big',
                'String.blink',
                'String.bold',
                'String.fixed',
                'String.fontcolor',
                'String.fontsize',
                'String.italics',
                'String.link',
                'String.small',
                'String.strike',
                'String.sub',
                'String.sup',
                'URL',
                'URLSearchParams',
                'RegExp',
                'Number',
                'Math',
                'Date',
                'async',
                'Symbol',
                'Map',
                'Set',
                'WeakMap',
                'WeakSet',
                'ArrayBuffer',
                'DataView',
                'Int8Array',
                'Uint8Array',
                'Uint8ClampedArray',
                'Int16Array',
                'Uint16Array',
                'Int32Array',
                'Uint32Array',
                'Float32Array',
                'Float64Array',
                'Reflect'
            ]
        },
        rules: {
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'default',
                    format: [ 'camelCase', 'PascalCase' ],
                    leadingUnderscore: 'allow'
                },
                {
                    selector: 'variable',
                    format: [ 'camelCase', 'PascalCase', 'UPPER_CASE' ],
                    leadingUnderscore: 'allowSingleOrDouble',
                    trailingUnderscore: 'allowSingleOrDouble'
                },
                {
                    selector: 'typeLike',
                    format: [ 'PascalCase' ]
                },
                {
                    selector: 'enumMember',
                    format: [ 'PascalCase', 'UPPER_CASE' ]
                },
                {
                    selector: [ 'objectLiteralProperty', 'typeProperty' ],
                    format: [ 'camelCase', 'PascalCase' ],
                    leadingUnderscore: 'allowSingleOrDouble',
                    trailingUnderscore: 'allowSingleOrDouble'
                },
                // Ignore numbers, locale strings (en-us), aria/data attributes and CSS selectors
                {
                    selector: [ 'objectLiteralProperty', 'typeProperty' ],
                    format: null,
                    filter: {
                        regex: '[ &\\-]|^([0-9]+)$',
                        match: true
                    }
                }
            ],
            '@typescript-eslint/no-deprecated': 'warn',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/prefer-string-starts-ends-with': 'error'
        }
    }
);
