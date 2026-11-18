// 检查界面代码里用到的颜色都在主题里登记过。pnpm lint 会运行它。
//
// 主题（packages/ui/src/styles/index.css）把 Tailwind 自带的颜色全部清掉了，只留登记过的名称。
// 用了没有登记的颜色，例如 bg-black、text-red-500，对应的样式不会生成，也不会报错：
// 写的人以为有，实际上没有。看大图时的深色遮罩就这样悄悄失效过。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const theme = readFileSync(join(root, 'packages/ui/src/styles/index.css'), 'utf8')
const registered = new Set([...theme.matchAll(/--color-([a-z0-9-]+):/g)].map((match) => match[1]))

// Tailwind 自带的颜色名。写了这些名字，多半是以为它们还在
const BUILT_IN =
  'black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
// 会带颜色的那些类名的前缀
const PREFIX =
  'bg|text|border|outline|ring|fill|stroke|divide|decoration|caret|accent|shadow|from|via|to|placeholder'
const USED = new RegExp(`(?<![\\w-])(?:${PREFIX})-((?:${BUILT_IN})(?:-\\d{2,3})?)(?![\\w-])`, 'g')

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return /\.(tsx?|css)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
  })
}

const problems = []
for (const file of sources(join(root, 'packages/ui/src'))) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const [written, color] of line.matchAll(USED)) {
      if (!registered.has(color)) {
        problems.push(`${relative(root, file)}:${index + 1}  ${written}`)
      }
    }
  })
}

if (problems.length > 0) {
  console.error('用到了主题里没有登记的颜色，对应的样式不会生成：\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    '\n改用主题里登记的名称，或者在 packages/ui/src/styles/index.css 的 @theme 里登记它。',
  )
  process.exit(1)
}
console.log(`颜色检查通过（主题里登记了 ${registered.size} 种）`)
