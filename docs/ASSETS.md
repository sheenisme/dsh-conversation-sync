# Artwork and assets

[中文版本](ASSETS.zh-CN.md)

The **code** in this repository is MIT-licensed (see [LICENSE](../LICENSE)).
The images under `docs/` are credited separately below, since they come from
different places.

| File | What it is | Terms |
| --- | --- | --- |
| `docs/cover.png`, `docs/cover.svg` | the cover image: layout, panel mock, typography and colours, drawn for this project | MIT, like the code |
| `docs/mascot.png` | the little whale, as downloaded | from the source below — **non-commercial use, with credit** |
| `docs/mascot-soft.png` | the same art with its right and bottom edges faded into transparency (alpha channel only), so it sits on the gradient without a hard square cut | same terms as `mascot.png` |

## The little whale in the cover

`docs/mascot.png` is an unmodified copy of `assets/DSniang1.png` from
[meteornox/deepseek-balance-whale-widget](https://github.com/meteornox/deepseek-balance-whale-widget)
(verified byte-for-byte identical to the upstream file).

That project licenses its **code** under MIT, but its
[`PROVENANCE.md`](https://github.com/meteornox/deepseek-balance-whale-widget/blob/main/PROVENANCE.md)
sets its `assets/**` artwork apart: the art is provided **as-is**, with no
sublicence granted and no claim that it is original work, and the maintainers
ask only that it be removed if a rights holder objects.

This project is free and non-commercial and **credits** its source in both
READMEs and here. That matches how the source offers the art, so the cover uses
the character the way its authors intended.

`docs/mascot.png` keeps the upstream bytes exactly. `docs/mascot-soft.png` is
derived from it by lowering the alpha channel over the last few percent of the
right and bottom edges — the drawing itself is untouched. Neither file changes
the terms above.

The one thing to keep in mind:

> **Non-commercial use only.** This project is free and non-commercial. If you
> fork it into a commercial product, replace `docs/mascot.png` first — the
> upstream terms do not grant commercial reuse, and this plugin's MIT licence
> does not change that.

If the maintainers (or a rights holder) ask, the image will be removed. No
conditions.

## Removing the character

If you want a cover with no third-party art at all, delete both `docs/mascot.png`
and `docs/mascot-soft.png`, plus the `<image>` line near the end of
`docs/cover.svg`, then re-render:

```bash
inkscape docs/cover.svg --export-type=png \
  --export-filename=docs/cover.png --export-width=1280 --export-height=640
```

The cover renders normally, just without the whale.
