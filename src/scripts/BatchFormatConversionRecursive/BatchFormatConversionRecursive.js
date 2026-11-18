// BatchFormatConversionRecursive.js
//
// Converts image files to compressed XISF, taking files and whole folders (recursive), and writes
// each output next to its source with the same name, so a folder tree keeps its layout.
// Read/write follows the stock BatchFormatConversion script: keywords, image properties, metadata,
// ICC profile and thumbnail are carried over. FITS sources are never modified or deleted.
// With recompress, XISF files in another codec are rewritten in place and the original is kept as
// <name>.xisf.orig until a verification step removes it.
//
// Automation (no dialog), e.g. from IPC:
//   PixInsight.exe -n --automation-mode -r="<this script>,list=<file>,manifest=<file.csv>" --force-exit
// Arguments, one key=value each (IPC splits at commas, so paths go in the list file):
//   list=       text file, one file or folder per line
//   manifest=   CSV appended with source,output,status,detail per file
//   codec=      XISF compression codec, default zstd+sh
//   level=      compression level 1-100, 0 for the codec default, default 25
//   checksum=   sha-1, sha-256, sha-512 or none, default sha-1
//   extensions= semicolon separated input suffixes, default .fits;.fit;.fts
//   recompress= true to also rewrite .xisf files stored with another codec
//   overwrite=  true to replace an existing XISF converted from FITS, default false (skipped)

#engine v8

#feature-id    BatchFormatConversionRecursive : Batch Processing > BatchFormatConversionRecursive

#feature-info  Converts files and folders (recursively) to compressed XISF next to each source.

#define VERSION            "1.1.1"
#define TITLE              "BatchFormatConversionRecursive"
#define DEFAULT_CODEC      "zstd+sh"
#define DEFAULT_LEVEL      25
#define DEFAULT_CHECKSUM   "sha-1"
#define DEFAULT_EXTENSIONS ".fits;.fit;.fts"
#define OUTPUT_EXTENSION   ".xisf"
#define TEMP_SUFFIX        ".partial"
#define ORIGINAL_SUFFIX    ".orig"
#define HEADER_PROBE_BYTES 65536
#define XISF_PREAMBLE_BYTES 16

CoreApplication.ensureMinimumVersion( 1, 9, 6 );

#include <pjsr/utility/ScriptErrors.js>

const CODECS = [ "zstd+sh", "lz4hc+sh", "lz4+sh", "zlib+sh", "zstd", "lz4hc", "lz4", "zlib", "none" ];
const CHECKSUMS = [ "sha-1", "sha-256", "sha-512", "none" ];

function csvField( text )
{
   let value = String( text );
   return /[",\n]/.test( value ) ? '"' + value.replace( /"/g, '""' ) + '"' : value;
}

function parseSuffixes( text )
{
   return text.toLowerCase().split( ";" ).map( suffix => suffix.trim() ).filter( suffix => suffix.length );
}

// Codec named in an XISF header, "none" when the image is stored uncompressed.
function xisfCodec( path )
{
   let file = new File;
   file.openForReading( path );
   // The XML header follows a 16 byte binary preamble, whose zero bytes would end the string early.
   file.seek( XISF_PREAMBLE_BYTES );
   let bytes = file.read( DataType.ByteArray, Math.min( HEADER_PROBE_BYTES, file.size - XISF_PREAMBLE_BYTES ) );
   file.close();
   let match = bytes.toString().match( /compression="([^:"]+)/ );
   return match ? match[1] : "none";
}

class ConversionEngine
{
   inputs = [];
   recursive = true;
   extensions = parseSuffixes( DEFAULT_EXTENSIONS );
   codec = DEFAULT_CODEC;
   level = DEFAULT_LEVEL;
   checksum = DEFAULT_CHECKSUM;
   recompress = false;
   overwriteExisting = false;
   manifestPath = "";
   converted = 0;
   skipped = 0;
   failed = 0;

   wantsFile( path )
   {
      let suffix = File.extractExtension( path ).toLowerCase();
      return this.extensions.indexOf( suffix ) >= 0 || (this.recompress && suffix == OUTPUT_EXTENSION);
   }

   outputHints()
   {
      let hints = [ "non-interactive" ];
      if ( this.codec != "none" )
      {
         hints.push( "compression-codec " + this.codec );
         if ( this.level > 0 )
            hints.push( "compression-level " + this.level );
      }
      hints.push( this.checksum == "none" ? "no-checksums" : "checksums " + this.checksum );
      return hints.join( " " );
   }

   // Expands the input list into files, walking folders (recursively when enabled).
   collectFiles()
   {
      let files = [];
      let walk = ( directory ) => {
         let finder = new FileFind;
         if ( finder.begin( directory + "/*" ) )
            do
            {
               if ( finder.name == "." || finder.name == ".." )
                  continue;
               let path = directory + "/" + finder.name;
               if ( finder.isDirectory )
               {
                  if ( this.recursive )
                     walk( path );
               }
               else if ( this.wantsFile( path ) )
                  files.push( path );
            }
            while ( finder.next() );
      };
      for ( let input of this.inputs )
      {
         let path = input.replace( /\\/g, "/" ).replace( /\/+$/, "" );
         if ( File.directoryExists( path ) )
            walk( path );
         else if ( File.exists( path ) && this.wantsFile( path ) )
            files.push( path );
         else
            this.record( path, "", "failed", "not found or not a convertible file" );
      }
      return files;
   }

   record( source, output, status, detail )
   {
      if ( status == "converted" ) ++this.converted;
      else if ( status == "skipped" ) ++this.skipped;
      else ++this.failed;
      console.writeln( "<end><cbr>" + status + ": <raw>" + source + "</raw>" + (detail ? " (" + detail + ")" : "") );
      if ( this.manifestPath.length == 0 )
         return;
      let manifest = new File;
      manifest.openOrCreate( this.manifestPath );
      manifest.seekEnd();
      manifest.outTextLn( [ source, output, status, detail ].map( csvField ).join( "," ) );
      manifest.close();
   }

   readSource( sourcePath )
   {
      let inputFormat = new FileFormat( File.extractExtension( sourcePath ).toLowerCase(), true/*toRead*/, false/*toWrite*/ );
      if ( inputFormat.isNull )
         throw new Error( "No installed file format can read this file" );
      let reader = new FileFormatInstance( inputFormat );
      let descriptions = reader.open( sourcePath, "non-interactive" );
      if ( descriptions == null || descriptions.length == 0 )
         throw new Error( "Unable to open file" );
      // Extra images are extensions such as the thumbnail and astrometric solution PixInsight adds
      // when it re-saves a solved FITS; the first image is the frame itself.
      if ( descriptions.length > 1 )
         reader.selectedImageIndex = 0;
      let description = descriptions[0];
      let image = new Image( 1, 1, 1, ColorSpace.Gray, description.bitsPerSample,
                             description.ieeefpSampleFormat ? PixelSampleType.Float : PixelSampleType.Integer );
      if ( !reader.readImage( image ) )
         throw new Error( "Unable to read image data" );
      let source = {
         imageCount: descriptions.length,
         image: image,
         description: description,
         keywords: reader.format.canStoreKeywords ? reader.keywords : undefined,
         iccProfile: reader.format.canStoreICCProfiles ? reader.iccProfile : undefined,
         metadata: reader.format.canStoreMetadata ? reader.metadata : undefined,
         thumbnail: reader.format.canStoreThumbnails ? reader.thumbnail : undefined,
         properties: []
      };
      if ( reader.format.canStoreImageProperties && reader.format.supportsViewProperties )
         for ( let entry of reader.imageProperties )
         {
            let value = reader.readImageProperty( entry[0] );
            if ( value != null )
               source.properties.push( { id: entry[0], type: entry[1], value: value } );
         }
      reader.close();
      return source;
   }

   // Writes under a temporary name, so an interrupted run never leaves a truncated file that
   // looks finished. Returns the temporary path for the caller to rename.
   writeTemporary( source, outputPath, outputFormat )
   {
      let temporaryPath = outputPath + TEMP_SUFFIX;
      if ( File.exists( temporaryPath ) )
         File.remove( temporaryPath );
      let writer = new FileFormatInstance( outputFormat );
      if ( !writer.create( temporaryPath, this.outputHints() ) )
         throw new Error( "Unable to create output file" );
      let outputDescription = new ImageDescription( source.description );
      outputDescription.bitsPerSample = source.image.bitsPerSample;
      outputDescription.ieeefpSampleFormat = source.image.isReal;
      if ( !writer.setOptions( outputDescription ) )
         throw new Error( "Unable to set output options" );
      if ( source.iccProfile != undefined && outputFormat.canStoreICCProfiles ) writer.iccProfile = source.iccProfile;
      if ( source.keywords != undefined ) writer.keywords = source.keywords;
      if ( source.metadata != undefined && outputFormat.canStoreMetadata ) writer.metadata = source.metadata;
      if ( source.thumbnail != undefined && outputFormat.canStoreThumbnails ) writer.thumbnail = source.thumbnail;
      for ( let property of source.properties )
         writer.writeImageProperty( property.id, property.value, property.type );
      if ( !writer.writeImage( source.image ) )
         throw new Error( "Unable to write image data" );
      writer.close();
      source.image.free();
      return temporaryPath;
   }

   convertFile( sourcePath, outputFormat )
   {
      let detail = this.codec + (this.level > 0 ? " level " + this.level : "") + ", " + this.checksum;
      if ( File.extractExtension( sourcePath ).toLowerCase() == OUTPUT_EXTENSION )
      {
         let originalPath = sourcePath + ORIGINAL_SUFFIX;
         if ( File.exists( originalPath ) )
            return this.record( sourcePath, sourcePath, "skipped", "original kept for verification" );
         if ( xisfCodec( sourcePath ) == this.codec )
            return this.record( sourcePath, sourcePath, "skipped", "already " + this.codec );
         let temporaryPath = this.writeTemporary( this.readSource( sourcePath ), sourcePath, outputFormat );
         File.move( sourcePath, originalPath );
         File.move( temporaryPath, sourcePath );
         return this.record( originalPath, sourcePath, "converted", detail + ", recompressed" );
      }

      let outputPath = File.changeExtension( sourcePath, OUTPUT_EXTENSION );
      if ( File.exists( outputPath ) && !this.overwriteExisting )
         return this.record( sourcePath, outputPath, "skipped", "output exists" );
      let source = this.readSource( sourcePath );
      if ( source.imageCount > 1 )
         detail += ", first of " + source.imageCount + " images";
      let temporaryPath = this.writeTemporary( source, outputPath, outputFormat );
      if ( File.exists( outputPath ) )
         File.remove( outputPath );
      File.move( temporaryPath, outputPath );
      this.record( sourcePath, outputPath, "converted", detail );
   }

   run()
   {
      let outputFormat = new FileFormat( OUTPUT_EXTENSION, false/*toRead*/, true/*toWrite*/ );
      if ( outputFormat.isNull )
         throw new Error( "No installed file format can write XISF files" );
      let files = this.collectFiles();
      console.show();
      console.writeln( "<end><cbr><br>" + TITLE + ": " + files.length + " files, " + this.outputHints() );
      console.flush();
      for ( let index = 0; index < files.length; ++index )
      {
         console.abortEnabled = true;
         try
         {
            this.convertFile( files[index], outputFormat );
         }
         catch ( error )
         {
            this.record( files[index], "", "failed", error.message );
         }
         processEvents();
         if ( console.abortRequested )
         {
            console.warningln( "<end><cbr>Aborted after " + (index + 1) + " of " + files.length + " files" );
            break;
         }
      }
      console.writeln( "<end><cbr>" + TITLE + " done: " + this.converted + " converted, " +
                       this.skipped + " skipped, " + this.failed + " failed" );
      Runtime.jsScriptResult = this.failed;
   }
}

class ConversionDialog extends Dialog
{
   constructor( engine )
   {
      super();
      this.engine = engine;
      this.windowTitle = TITLE + " " + VERSION;

      this.inputList = new TreeBox( this );
      this.inputList.rootDecoration = false;
      this.inputList.numberOfColumns = 1;
      this.inputList.headerVisible = false;
      this.inputList.multipleSelection = true;
      this.inputList.setMinSize( 640, 250 );

      let addPath = ( path ) => {
         let node = new TreeBoxNode( this.inputList );
         node.setText( 0, path );
         engine.inputs.push( path );
      };

      this.addFilesButton = new PushButton( this );
      this.addFilesButton.text = "Add Files";
      this.addFilesButton.onClick = () => {
         let picker = new OpenFileDialog;
         picker.multipleSelections = true;
         picker.caption = TITLE + ": Select Files";
         picker.loadImageFilters();
         if ( picker.execute() )
            for ( let path of picker.fileNames )
               addPath( path );
      };

      this.addFolderButton = new PushButton( this );
      this.addFolderButton.text = "Add Folder";
      this.addFolderButton.onClick = () => {
         let picker = new GetDirectoryDialog;
         picker.caption = TITLE + ": Select Folder";
         if ( picker.execute() )
            addPath( picker.directoryPath );
      };

      this.removeButton = new PushButton( this );
      this.removeButton.text = "Remove Selected";
      this.removeButton.onClick = () => {
         for ( let index = this.inputList.numberOfChildren - 1; index >= 0; --index )
            if ( this.inputList.child( index ).selected )
            {
               engine.inputs.splice( index, 1 );
               this.inputList.remove( index );
            }
      };

      this.clearButton = new PushButton( this );
      this.clearButton.text = "Clear";
      this.clearButton.onClick = () => {
         this.inputList.clear();
         engine.inputs = [];
      };

      this.listButtons = new VerticalSizer;
      this.listButtons.spacing = 4;
      this.listButtons.add( this.addFilesButton );
      this.listButtons.add( this.addFolderButton );
      this.listButtons.add( this.removeButton );
      this.listButtons.add( this.clearButton );
      this.listButtons.addStretch();

      this.listSizer = new HorizontalSizer;
      this.listSizer.spacing = 6;
      this.listSizer.add( this.inputList, 100 );
      this.listSizer.add( this.listButtons );

      this.recursiveCheck = new CheckBox( this );
      this.recursiveCheck.text = "Include subfolders";
      this.recursiveCheck.checked = engine.recursive;
      this.recursiveCheck.onCheck = ( checked ) => { engine.recursive = checked; };

      this.recompressCheck = new CheckBox( this );
      this.recompressCheck.text = "Recompress XISF";
      this.recompressCheck.toolTip = "<p>Also rewrite .xisf files stored with another codec. The original is kept as " +
                                     "&lt;name&gt;.xisf.orig until you delete it.</p>";
      this.recompressCheck.checked = engine.recompress;
      this.recompressCheck.onCheck = ( checked ) => { engine.recompress = checked; };

      this.overwriteCheck = new CheckBox( this );
      this.overwriteCheck.text = "Overwrite existing XISF";
      this.overwriteCheck.checked = engine.overwriteExisting;
      this.overwriteCheck.onCheck = ( checked ) => { engine.overwriteExisting = checked; };

      this.extensionsLabel = new Label( this );
      this.extensionsLabel.text = "Input suffixes:";
      this.extensionsLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.extensionsEdit = new Edit( this );
      this.extensionsEdit.text = engine.extensions.join( ";" );
      this.extensionsEdit.onEditCompleted = () => { engine.extensions = parseSuffixes( this.extensionsEdit.text ); };

      this.checksSizer = new HorizontalSizer;
      this.checksSizer.spacing = 8;
      this.checksSizer.add( this.recursiveCheck );
      this.checksSizer.add( this.recompressCheck );
      this.checksSizer.add( this.overwriteCheck );
      this.checksSizer.addStretch();
      this.checksSizer.add( this.extensionsLabel );
      this.checksSizer.add( this.extensionsEdit );

      this.codecLabel = new Label( this );
      this.codecLabel.text = "Compression:";
      this.codecLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.codecCombo = new ComboBox( this );
      for ( let codec of CODECS )
         this.codecCombo.addItem( codec );
      this.codecCombo.currentItem = Math.max( 0, CODECS.indexOf( engine.codec ) );
      this.codecCombo.onItemSelected = ( index ) => { engine.codec = CODECS[index]; };

      this.levelLabel = new Label( this );
      this.levelLabel.text = "Level:";
      this.levelLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.levelSpin = new SpinBox( this );
      this.levelSpin.minValue = 0;
      this.levelSpin.maxValue = 100;
      this.levelSpin.value = engine.level;
      this.levelSpin.toolTip = "<p>Compression level 1-100, 0 uses the codec default.</p>";
      this.levelSpin.onValueUpdated = ( value ) => { engine.level = value; };

      this.checksumLabel = new Label( this );
      this.checksumLabel.text = "Checksum:";
      this.checksumLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.checksumCombo = new ComboBox( this );
      for ( let checksum of CHECKSUMS )
         this.checksumCombo.addItem( checksum );
      this.checksumCombo.currentItem = Math.max( 0, CHECKSUMS.indexOf( engine.checksum ) );
      this.checksumCombo.onItemSelected = ( index ) => { engine.checksum = CHECKSUMS[index]; };

      this.formatSizer = new HorizontalSizer;
      this.formatSizer.spacing = 6;
      this.formatSizer.addStretch();
      this.formatSizer.add( this.codecLabel );
      this.formatSizer.add( this.codecCombo );
      this.formatSizer.add( this.levelLabel );
      this.formatSizer.add( this.levelSpin );
      this.formatSizer.add( this.checksumLabel );
      this.formatSizer.add( this.checksumCombo );

      this.convertButton = new PushButton( this );
      this.convertButton.text = "Convert";
      this.convertButton.onClick = () => {
         if ( engine.inputs.length == 0 )
            new MessageBox( "Add at least one file or folder.", TITLE, StdIcon.Warning, StdButton.Ok ).execute();
         else
            this.ok();
      };
      this.cancelButton = new PushButton( this );
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = () => { this.cancel(); };

      this.buttonsSizer = new HorizontalSizer;
      this.buttonsSizer.spacing = 6;
      this.buttonsSizer.addStretch();
      this.buttonsSizer.add( this.convertButton );
      this.buttonsSizer.add( this.cancelButton );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.listSizer, 100 );
      this.sizer.add( this.checksSizer );
      this.sizer.add( this.formatSizer );
      this.sizer.add( this.buttonsSizer );
      this.adjustToContents();
   }
}

function main()
{
   Runtime.jsScriptInformation = TITLE + " " + VERSION;
   Runtime.jsScriptResult = 0;

   let engine = new ConversionEngine;
   let options = {};
   for ( let argument of (Runtime.jsArguments || []) )
   {
      let text = String( argument );
      let split = text.indexOf( "=" );
      if ( split > 0 )
         options[ text.substring( 0, split ).trim().toLowerCase() ] = text.substring( split + 1 ).trim();
   }

   if ( options.list )
   {
      engine.inputs = File.readLines( options.list ).map( line => line.trim() ).filter( line => line.length && !line.startsWith( "#" ) );
      if ( options.manifest ) engine.manifestPath = options.manifest;
      if ( options.codec ) engine.codec = options.codec;
      if ( options.level ) engine.level = parseInt( options.level );
      if ( options.checksum ) engine.checksum = options.checksum;
      if ( options.extensions ) engine.extensions = parseSuffixes( options.extensions );
      if ( options.recompress ) engine.recompress = options.recompress == "true";
      if ( options.overwrite ) engine.overwriteExisting = options.overwrite == "true";
      if ( CODECS.indexOf( engine.codec ) < 0 )
         throw new Error( "Unknown codec " + engine.codec + ", expected one of " + CODECS.join( ", " ) );
      if ( CHECKSUMS.indexOf( engine.checksum ) < 0 )
         throw new Error( "Unknown checksum " + engine.checksum + ", expected one of " + CHECKSUMS.join( ", " ) );
      engine.run();
      return;
   }

   let dialog = new ConversionDialog( engine );
   if ( dialog.execute() )
      engine.run();
}

main();
