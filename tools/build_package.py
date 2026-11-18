"""Build the PixInsight update package: zip src/ and write updates/updates.xri with its SHA-1.

Usage: python tools/build_package.py
Run after signing every script (CodeSign writes a .xsgn next to each .js), then sign
updates/updates.xri with CodeSign. PixInsight extracts the zip into its installation folder,
so paths inside the zip start at src/.
"""
import datetime
import hashlib
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src"
UPDATES = ROOT / "updates"
PACKAGE_PREFIX = "pixinsight-scripts-"
# Oldest PixInsight version the scripts run on (BatchFormatConversionRecursive requires 1.9.6).
PIXINSIGHT_VERSIONS = "1.9.6:2.0.0"

XRI_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>pixinsight-scripts: scripts by Ofir Pardo, https://github.com/pardovot/pixinsight-scripts</p>
   </description>
   <platform os="all" arch="noarch" version="{versions}">
      <package fileName="{file_name}" sha1="{sha1}" type="script" releaseDate="{release_date}">
         <title>pixinsight-scripts</title>
         <description>
            <p>{scripts}</p>
         </description>
      </package>
   </platform>
</xri>
"""


def main():
    scripts = sorted(SOURCE.rglob("*.js"))
    unsigned = [script for script in scripts if not script.with_suffix(".xsgn").exists()]
    if unsigned:
        sys.exit("Sign these with Script > Development > CodeSign first: " + ", ".join(str(path) for path in unsigned))

    release_date = datetime.date.today().strftime("%Y%m%d")
    package = UPDATES / f"{PACKAGE_PREFIX}{release_date}.zip"
    for old in UPDATES.glob(f"{PACKAGE_PREFIX}*.zip"):
        old.unlink()
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(SOURCE.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(ROOT).as_posix())

    sha1 = hashlib.sha1(package.read_bytes()).hexdigest()
    names = ", ".join(script.stem for script in scripts)
    (UPDATES / "updates.xri").write_text(
        XRI_TEMPLATE.format(versions=PIXINSIGHT_VERSIONS, file_name=package.name, sha1=sha1,
                            release_date=release_date, scripts=names),
        encoding="utf-8")
    print(f"{package.name} sha1 {sha1}, {len(scripts)} scripts. Now sign updates/updates.xri with CodeSign.")


if __name__ == "__main__":
    main()
