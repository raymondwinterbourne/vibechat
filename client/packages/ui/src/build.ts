// 这个页面自己的构建编号（U1）：构建时写进页面的 meta。开发环境里没有。

export function pageBuild(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="vc-build"]')?.content || null
}
