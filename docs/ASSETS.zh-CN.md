# 素材与版权

[English version](ASSETS.md)

本仓库中的**代码**采用 MIT 许可证（见 [LICENSE](../LICENSE)）。
`docs/` 下的图片在下方单独标注来源，因为它们来自
不同的地方。

| 文件 | 说明 | 条款 |
| --- | --- | --- |
| `docs/cover.png`, `docs/cover.svg` | 封面图片：版式、面板示意图、排版和配色，为本项目绘制 | MIT，与代码相同 |
| `docs/mascot.png` | 封面中的小鲸鱼，原样下载所得 | 来源见下方 — **仅限非商业使用，需署名** |
| `docs/mascot-soft.png` | 同一张素材，仅对右侧与底部的 alpha 通道做渐隐，使其落在渐变背景上时不出现生硬的方形切边 | 条款同 `mascot.png` |

## 封面中的小鲸鱼

`docs/mascot.png` 是 `assets/DSniang1.png` 的未修改副本，来自
[meteornox/deepseek-balance-whale-widget](https://github.com/meteornox/deepseek-balance-whale-widget)
（经逐字节核验与上游文件完全一致）。

该项目将其**代码**以 MIT 许可证授权，但其
[`PROVENANCE.md`](https://github.com/meteornox/deepseek-balance-whale-widget/blob/main/PROVENANCE.md)
将 `assets/**` 中的素材单独列出：这些素材按 **as-is** 提供，
未授予再许可，也不声称是原创作品；维护者仅要求
在权利人提出异议时将其移除。

本项目免费且非商业，使用该文件时**未作修改**
（与上游字节一致），并在两份 README 以及此处**注明**来源。
这与来源方提供素材的方式相符，因此封面按作者预期的方式
使用了该角色。

唯一需要注意的一点：

> **仅限非商业使用。** 本项目免费且非商业。如果你将其
> fork 为商业产品，请先替换 `docs/mascot.png` — 上游
> 条款未授予商业复用权，本插件的 MIT 许可证
> 也不会改变这一点。

如果维护者（或权利人）提出要求，该图片将被移除。
没有任何附加条件。

## 移除该角色

`docs/mascot.png` 与上游字节完全一致；`docs/mascot-soft.png` 只在右侧和底部最后
几个百分点的 alpha 通道上做了递减，画面本身没有被改动。两者都不改变上述条款。

如果你希望封面完全不含第三方素材，请删除 `docs/mascot.png` 与 `docs/mascot-soft.png`
以及 `docs/cover.svg` 末尾附近的 `<image>` 行，然后重新渲染：

```bash
inkscape docs/cover.svg --export-type=png \
  --export-filename=docs/cover.png --export-width=1280 --export-height=640
```

封面仍能正常渲染，只是没有鲸鱼。
