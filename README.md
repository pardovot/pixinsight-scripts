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

Converts image files to compressed XISF. Takes files and whole folders, walks folders recursively and writes each output next to its source under the same name, so a folder tree keeps its layout. Keywords, image properties, metadata, ICC profile and thumbnail are carried over, the default codec is lz4hc+sh, existing outputs are skipped and sources are never modified or deleted.

It also runs without a dialog, for batch jobs started from the command line:

```
PixInsight.exe -n --automation-mode -r="<path>/BatchFormatConversionRecursive.js,list=<list.txt>,manifest=<manifest.csv>" --force-exit
```

`list.txt` holds one file or folder per line (PixInsight splits script arguments at commas, so paths go in the file). Optional arguments: `codec=` (lz4hc+sh, zstd+sh, zlib+sh, ...), `extensions=` (default `.fits;.fit;.fts`) and `overwrite=true`. The manifest gets one `source,output,status,detail` line per file.

## Releasing

1. Sign each changed script with Script > Development > CodeSign (writes a `.xsgn` next to the `.js`).
2. `python tools/build_package.py` zips `src/` into `updates/` and writes `updates/updates.xri`.
3. Sign `updates/updates.xri` with CodeSign.
4. Commit and push.
