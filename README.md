# pixinsight-scripts

PixInsight scripts, installable through PixInsight's update system.

## Install

In PixInsight open Resources > Updates > Manage Repositories, add

```
https://raw.githubusercontent.com/pardovot/pixinsight-scripts/main/updates/
```

then run Resources > Updates > Check for Updates and restart PixInsight. The scripts stay installed across PixInsight upgrades because the update system reinstalls them.

## Scripts

### BatchFormatConversionRecursive

Script > Batch Processing > BatchFormatConversionRecursive

Converts image files to compressed XISF. Takes files and whole folders, walks folders recursively and writes each output next to its source under the same name, so a folder tree keeps its layout. Keywords, image properties, metadata, ICC profile and thumbnail are carried over, existing outputs are skipped and FITS sources are never modified or deleted.

The default is zstd with byte shuffling at level 25 and a SHA-1 checksum. On raw 26 MP frames that was 54-56% of the FITS size, about 8% smaller than lz4hc+sh while writing four times faster and reading as fast. Higher levels add little size gain for much slower writes, and the checksum lets PixInsight detect a file corrupted on disk.

With Recompress XISF, `.xisf` files stored with another codec (for example lz4hc+sh written by NINA) are rewritten in place. Each original is kept as `<name>.xisf.orig` until you delete it, so check the new files first.

It also runs without a dialog, for batch jobs started from the command line:

```
PixInsight.exe -n --automation-mode -r="<path>/BatchFormatConversionRecursive.js,list=<list.txt>,manifest=<manifest.csv>" --force-exit
```

`list.txt` holds one file or folder per line (PixInsight splits script arguments at commas, so paths go in the file). Optional arguments: `codec=` (zstd+sh, lz4hc+sh, zlib+sh, ...), `level=` (1-100, 0 for the codec default), `checksum=` (sha-1, sha-256, sha-512, none), `extensions=` (default `.fits;.fit;.fts`), `recompress=true` and `overwrite=true`. The manifest gets one `source,output,status,detail` line per file.

## Releasing

1. `python tools/build_package.py` zips `src/` into `updates/` and writes `updates/updates.xri`.
2. Commit and push.

The package is unsigned. PixInsight runs unsigned scripts, signing would need a certified developer key.
