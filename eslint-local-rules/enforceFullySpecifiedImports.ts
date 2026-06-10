import { RuleCreator } from '@typescript-eslint/utils/eslint-utils'
import { moduleVisitor } from 'eslint-plugin-import-x/utils'

// Relative specifiers must carry one of these runtime extensions to be resolvable under strict ESM.
const RUNTIME_EXTENSION = /\.(js|mjs|cjs|json)$/
// TypeScript source extensions are never present at runtime — flag them with a targeted hint.
const TYPESCRIPT_EXTENSION = /\.(ts|tsx|mts|cts)$/

export default RuleCreator.withoutDocs({
  meta: {
    docs: {
      description:
        'Require relative imports to be fully specified with a runtime extension (e.g. `./util/index.js`), as ' +
        'strict ESM packages (`"type": "module"`) cannot resolve bare or directory specifiers.',
    },
    schema: [],
    messages: {
      missingExtension:
        "Relative import '{{source}}' must be fully specified with a runtime extension (e.g. './util/index.js'). " +
        'Strict ESM ("type": "module") cannot resolve bare or directory specifiers.',
      typescriptExtension:
        "Relative import '{{source}}' must use the emitted '.js' extension, not a TypeScript extension. " +
        'TypeScript emits import paths verbatim, so the `.ts` file does not exist at runtime.',
    },
    type: 'problem',
  },
  create(context) {
    return moduleVisitor(
      (source) => {
        const value = source.value
        if (typeof value !== 'string' || !value.startsWith('.')) {
          // Only relative specifiers; bare package specifiers are resolved by the package's own `exports`.
          return
        }
        if (RUNTIME_EXTENSION.test(value)) {
          return
        }
        context.report({
          node: source,
          messageId: TYPESCRIPT_EXTENSION.test(value) ? 'typescriptExtension' : 'missingExtension',
          data: { source: value },
        })
      },
      { commonjs: true }
    )
  },
})
