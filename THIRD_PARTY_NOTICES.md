# Third-party software

The lesson studios use [Inter Variable](https://rsms.me/inter/) by Rasmus Andersson. Inter is distributed under the SIL Open Font License 1.1. See [the font license](packages/shared-types/lessonStudios/Inter-OFL.txt).

Music notation uses [VexFlow 4.2.5](https://github.com/0xfe/vexflow/tree/4.2.5), Copyright 2010 Mohit Muthanna Cheppudira, under the [MIT License](packages/shared-types/lessonStudios/VexFlow-MIT.txt). Its [Bravura notation glyphs](https://github.com/steinbergmedia/bravura) are distributed under the SIL Open Font License 1.1.

The backend image includes unmodified [aeneas 1.7.3](https://github.com/readbeyond/aeneas), Copyright 2012–2017 ReadBeyond Srl, distributed under the GNU Affero General Public License version 3. Its Python command-line program runs in a separate process and exchanges audio, text and JSON files with Nous. The image contains the corresponding upstream source archive and complete license in `/opt/aeneas/source/`. Operators redistributing the image must retain these materials and the attribution. The upstream source is also available from [PyPI](https://pypi.org/project/aeneas/1.7.3.0/#files).

The operating-system packages eSpeak and FFmpeg retain their Debian copyright and license notices under `/usr/share/doc/`. Their source packages are available from the Debian repositories matching the image's Debian release. The Python environment retains dependency license metadata in `/opt/aeneas/lib/`.
