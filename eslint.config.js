import JS from '@eslint/js';
import GLOBALS from 'globals';
import PROJECT_RULES from './project/lint-rules.js';

const SOURCE_FILES = ['modules/**/*.{js,cjs,mjs}', 'project/**/*.{js,cjs,mjs}', '*.config.js'];

// Only pure runtime owners belong here. Rendering, input/DOM, navigation,
// transport/session persistence, audio and browser examples are adapters.
const CORE_FILES = [
    'modules/pixel-physics/core.js',
    'modules/_rollback-shared/*.js',
    'modules/deterministic/*.js',
    'modules/replay/*.js',
    'modules/interpolation/*.js',
    'modules/simloop/deadline.js',
    'modules/simloop/input-preview.js',
    'modules/simloop/rates.js',
    'modules/camera/*.js',
    'modules/presentation-events/*.js',
    'modules/object-pool/*.js',
    'modules/rollback/core.js',
    'modules/rollback/availability.js',
];
const CORE_BOUNDARY_MESSAGE = 'Core runtime must not depend on DOM, storage or presentation adapters.';
const CORE_ADAPTER_IMPORT = '(?:^|/)(?:rendering|hud|navigation)(?:/|$)|(?:^|/)(?:dom|storage)(?:\\.[cm]?js)?$';
const CORE_ADAPTER_SELECTOR = CORE_ADAPTER_IMPORT.replaceAll('/', '\\u002F');

export default [
    {
        name: 'gamekit/generated-and-vendor',
        ignores: [
            '**/node_modules/**',
            '**/vendor/**',
            'test-results/**',
            'playwright-report/**',
            '**/*.generated.*',
            '**/*.compiled.*',
            'dist/**',
            'modules/rollback/docs/provenance/**',
            'modules/pixel-physics/docs/provenance/**',
        ],
    },
    {
        name: 'gamekit/owned-javascript',
        files: SOURCE_FILES,
        languageOptions: { ecmaVersion: 'latest' },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        plugins: { project: PROJECT_RULES },
        rules: {
            ...JS.configs.recommended.rules,
            'project/binding-names': 'error',
            // Keep deliberate pre-initialization reads in setup/cleanup closures as let.
            'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
            'no-var': 'error',
            curly: ['error', 'all'],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-unused-vars': [
                'error',
                {
                    vars: 'all',
                    ignoreRestSiblings: true,
                    args: 'all',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    reportUsedIgnorePattern: true,
                },
            ],
            'no-unreachable': 'error',
            'no-dupe-class-members': 'error',
            'constructor-super': 'error',
            'no-this-before-super': 'error',
            'no-empty': ['error', { allowEmptyCatch: false }],
            // ESLint 10 includes this rule; review its replacement before upgrading to 11.
            'max-statements-per-line': ['error', { max: 1 }],
        },
    },
    {
        name: 'gamekit/inline-browser-scripts',
        files: ['modules/**/*.html'],
        plugins: { project: PROJECT_RULES },
        processor: 'project/inline-scripts',
    },
    {
        name: 'gamekit/browser',
        files: ['modules/**/*.js', 'modules/**/*.html/*.js', 'modules/**/tests/*.browser.mjs'],
        languageOptions: { globals: GLOBALS.browser },
    },
    {
        name: 'gamekit/node',
        files: [
            'project/**/*.{js,cjs,mjs}',
            'modules/**/scripts/*.{js,cjs,mjs}',
            'modules/**/tests/*.mjs',
            'modules/vector-assets/compiler.js',
            '*.config.js',
        ],
        languageOptions: { globals: GLOBALS.node },
    },
    {
        name: 'gamekit/browser-scenarios',
        files: ['project/tests/**/*.{js,mjs}', 'modules/**/tests/*.{js,mjs}', 'modules/**/scripts/*.mjs'],
        // Playwright evaluate callbacks execute in the browser.
        languageOptions: { globals: GLOBALS.browser },
    },
    {
        name: 'gamekit/core-boundaries',
        files: CORE_FILES,
        rules: {
            'no-restricted-globals': [
                'error',
                {
                    globals: [
                        { name: 'document', message: CORE_BOUNDARY_MESSAGE },
                        { name: 'localStorage', message: CORE_BOUNDARY_MESSAGE },
                    ],
                    checkGlobalObject: true,
                },
            ],
            'no-restricted-imports': [
                'error',
                { patterns: [{ regex: CORE_ADAPTER_IMPORT, caseSensitive: true, message: CORE_BOUNDARY_MESSAGE }] },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: `ImportExpression[source.value=/${CORE_ADAPTER_SELECTOR}/u]`,
                    message: CORE_BOUNDARY_MESSAGE,
                },
                {
                    selector: `CallExpression[callee.type='Identifier'][callee.name='require'][arguments.0.value=/${CORE_ADAPTER_SELECTOR}/u]`,
                    message: CORE_BOUNDARY_MESSAGE,
                },
            ],
        },
    },
];
