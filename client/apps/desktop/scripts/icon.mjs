// 生成应用的图标：品牌色的圆角方块上一个白色的字母 V。在容器里运行：node scripts/icon.mjs
//
// 输出 assets/icon.icns（打包用）和 assets/icon.png（1024 像素，给人看）。
// 这是占位的图标；以后有了正式的设计，换掉这两个文件就行，不用再运行这个脚本。
// 只用 Node 自带的东西：图是一个像素一个像素算出来的。
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const ACCENT = [0x5b, 0x5b, 0xd6]
/** 顶部比底部亮一点，图标看起来不那么平。 */
const LIGHTEN_TOP = 0.16
// macOS 的图标不占满整个画布：四周留白，方块的圆角大约是边长的 22%
const MARGIN = 100 / 1024
const RADIUS = 0.2237
// 字母 V 的轮廓，坐标是方块边长的比例
const LETTER = [
  [0.255, 0.3],
  [0.385, 0.3],
  [0.5, 0.585],
  [0.615, 0.3],
  [0.745, 0.3],
  [0.56, 0.725],
  [0.44, 0.725],
]
/** 每个像素取这么多乘这么多个点来算，边缘才平滑。 */
const SAMPLES = 4

function inRoundedSquare(x, y) {
  const dx = Math.max(RADIUS - x, 0, x - (1 - RADIUS))
  const dy = Math.max(RADIUS - y, 0, y - (1 - RADIUS))
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 && dx * dx + dy * dy <= RADIUS * RADIUS
}

function inLetter(x, y) {
  let inside = false
  for (let i = 0, j = LETTER.length - 1; i < LETTER.length; j = i++) {
    const [xi, yi] = LETTER[i]
    const [xj, yj] = LETTER[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 画一张边长为 `size` 像素的图，返回 RGBA 数据。 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const side = 1 - MARGIN * 2
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let square = 0
      let letter = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) / size - MARGIN) / side
          const y = ((py + (sy + 0.5) / SAMPLES) / size - MARGIN) / side
          if (!inRoundedSquare(x, y)) continue
          square += 1
          if (inLetter(x, y)) letter += 1
        }
      }
      if (square === 0) continue
      const white = letter / square
      const light = LIGHTEN_TOP * (1 - Math.min(Math.max((py / size - MARGIN) / side, 0), 1))
      const offset = (py * size + px) * 4
      for (let c = 0; c < 3; c++) {
        const base = ACCENT[c] + (255 - ACCENT[c]) * light
        pixels[offset + c] = Math.round(base + (255 - base) * white)
      }
      pixels[offset + 3] = Math.round((square / (SAMPLES * SAMPLES)) * 255)
    }
  }
  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

function png(size) {
  const pixels = render(size)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8) // 每个通道 8 位，带透明度
  const row = size * 4
  const raw = Buffer.alloc((row + 1) * size)
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// .icns 里每种尺寸一个条目，内容就是 PNG。类型代码是 macOS 规定的
const ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32], // 16 的两倍图
  ['ic12', 64], // 32 的两倍图
  ['ic13', 256], // 128 的两倍图
  ['ic14', 512], // 256 的两倍图
]

const images = new Map()
const image = (size) => {
  if (!images.has(size)) images.set(size, png(size))
  return images.get(size)
}
const entries = ENTRIES.map(([type, size]) => {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(image(size).length + 8, 4)
  return Buffer.concat([head, image(size)])
})
const body = Buffer.concat(entries)
const head = Buffer.alloc(8)
head.write('icns', 0, 'ascii')
head.writeUInt32BE(body.length + 8, 4)

const out = new URL('../assets/', import.meta.url)
mkdirSync(out, { recursive: true })
writeFileSync(new URL('icon.icns', out), Buffer.concat([head, body]))
writeFileSync(new URL('icon.png', out), image(1024))
console.log(`图标：${out.pathname}icon.icns（${ENTRIES.length} 种尺寸）和 icon.png`)
