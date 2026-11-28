# Artwork provenance

The **code** in this repository is MIT-licensed (see [LICENSE](../LICENSE)).
The images under `docs/` are handled separately, because their rights status is
not ours to license.

| File | What it is | Licence |
| --- | --- | --- |
| `docs/intro.png`, `docs/intro.svg` | the cover image: layout, panel mock, typography and colours, drawn for this project | MIT, like the code |
| `docs/mascot.png` | the whale character in the corner of the cover | **not MIT** — see below |

## `docs/mascot.png`

Taken unmodified from
[meteornox/deepseek-balance-whale-widget](https://github.com/meteornox/deepseek-balance-whale-widget),
file `assets/DSniang1.png` (610×610 PNG).

That repository licenses its **code** under MIT, but its
[`PROVENANCE.md`](https://github.com/meteornox/deepseek-balance-whale-widget/blob/main/PROVENANCE.md)
states that everything under `assets/**` is **not** covered by MIT: the artwork
is "provided as-is", granted no sublicence, and not claimed as original work.
So it is used here the same way that repository uses it — unmodified, as a
character marking this project — with credit in both READMEs.

It is not redistributed as part of the npm package's functionality, it carries no
licence of its own here, and it will be **removed on request**: open an issue and
it goes, no conditions.

If you fork this project and want to avoid the question entirely, delete
`docs/mascot.png` and the `<image>`/`clipPath` block at the end of
`docs/intro.svg`; the cover still renders, just without the character.
