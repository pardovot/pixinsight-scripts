// BatchFormatConversionRecursive.js
//
// Converts image files to compressed XISF, taking files and whole folders (recursive), and writes
// each output next to its source with the same name, so a folder tree keeps its layout.
// Read/write follows the stock BatchFormatConversion script: keywords, image properties, metadata,
// ICC profile and thumbnail are carried over. Sources are never modified or deleted.
//
// Automation (no dialog), e.g. from IPC:
//   PixInsight.exe -n --automation-mode -r="<this script>,list=<file>,manifest=<file.csv>" --force-exit
// Arguments, one key=value each (IPC splits at commas, so paths go in the list file):
//   list=      text file, one file or folder per line
//   manifest=  CSV appended with source,output,status,detail per file
//   codec=     XISF compression codec, default lz4hc+sh
//   extensions=semicolon separated input suffixes, default .fits;.fit;.fts
//   overwrite= true to replace an existing output, default false (existing outputs are skipped)

#engine v8

#feature-id    BatchFormatConversionRecursive : Batch Processing > BatchFormatConversionRecursive

#feature-info  Converts files and folders (recursively) to compressed XISF next to each source.

#define VERSION            "1.0.0"
#define TITLE              "BatchFormatConversionRecursive"
#define DEFAULT_CODEC      "lz4hc+sh"
#define DEFAULT_EXTENSIONS ".fits;.fit;.fts"
#define OUTPUT_EXTENSION   ".xisf"
#define TEMP_SUFFIX        ".partial"

CoreApplication.ensureMinimumVersion( 1, 9, 6 );

#include <pjsr/utility/ScriptErrors.js>

const CODECS = [ "lz4hc+sh", "lz4+sh", "zstd+sh", "zlib+sh", "lz4hc", "zstd", "zlib", "none" ];

function scriptArguments()
{
   if ( typeof Runtime !== "undefined" && Runtime.jsArguments && Runtime.jsArguments.length )
      return Runtime.jsArguments;
   if ( typeof jsArguments !== "undefined" && jsArguments )
      return jsArguments;
   return [];
}

function csvField( text )
{
   let value = String( text );
   return /[",\n]/.test( value ) ? '"' + value.replace( /"/g, '""' ) + '"' : value;
}

function parseSuffixes( text )
{
   return text.toLowerCase().split( ";" ).map( suffix => suffix.trim() ).filter( suffix => suffix.length );
}

class ConversionEngine
{
   inputs = [];
   recursive = true;
   extensions = parseSuffixes( DEFAULT_EXTENSIONS );
   codec = DEFAULT_CODEC;
   overwriteExisting = false;
   manifestPath = "";
   converted = 0;
   skipped = 0;
   failed = 0;

   wantsFile( path )
   {
      return this.extensions.indexOf( File.extractExtension( path ).toLowerCase() ) >= 0;
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

   convertFile( sourcePath, outputFormat )
   {
      let outputPath = File.changeExtension( sourcePath, OUTPUT_EXTENSION );
      if ( outputPath.toLowerCase() == sourcePath.toLowerCase() )
         return this.record( sourcePath, outputPath, "failed", "output would replace the source" );
      if ( File.exists( outputPath ) && !this.overwriteExisting )
         return this.record( sourcePath, outputPath, "skipped", "output exists" );

      let inputFormat = new FileFormat( File.extractExtension( sourcePath ).toLowerCase(), true/*toRead*/, false/*toWrite*/ );
      if ( inputFormat.isNull )
         throw new Error( "No installed file format can read this file" );
      let reader = new FileFormatInstance( inputFormat );
      let descriptions = reader.open( sourcePath, "non-interactive" );
      if ( descriptions == null || descriptions.length == 0 )
         throw new Error( "Unable to open file" );
      if ( descriptions.length > 1 )
         throw new Error( "Multi-image files are not supported" );
      let description = descriptions[0];
      let image = new Image( 1, 1, 1, ColorSpace.Gray, description.bitsPerSample,
                             description.ieeefpSampleFormat ? PixelSampleType.Float : PixelSampleType.Integer );
      if ( !reader.readImage( image ) )
         throw new Error( "Unable to read image data" );

      let keywords = reader.format.canStoreKeywords ? reader.keywords : undefined;
      let iccProfile = reader.format.canStoreICCProfiles ? reader.iccProfile : undefined;
      let metadata = reader.format.canStoreMetadata ? reader.metadata : undefined;
      let thumbnail = reader.format.canStoreThumbnails ? reader.thumbnail : undefined;
      let properties = [];
      if ( reader.format.canStoreImageProperties && reader.format.supportsViewProperties )
         for ( let entry of reader.imageProperties )
         {
            let value = reader.readImageProperty( entry[0] );
            if ( value != null )
               properties.push( { id: entry[0], type: entry[1], value: value } );
         }
      reader.close();

      // Written under a temporary name and renamed when complete, so an interrupted run never
      // leaves a truncated file that looks finished.
      let temporaryPath = outputPath + TEMP_SUFFIX;
      if ( File.exists( temporaryPath ) )
         File.remove( temporaryPath );
      let writer = new FileFormatInstance( outputFormat );
      let hints = "non-interactive" + (this.codec == "none" ? "" : " compression-codec " + this.codec);
      if ( !writer.create( temporaryPath, hints ) )
         throw new Error( "Unable to create output file" );
      let outputDescription = new ImageDescription( description );
      outputDescription.bitsPerSample = image.bitsPerSample;
      outputDescription.ieeefpSampleFormat = image.isReal;
      if ( !writer.setOptions( outputDescription ) )
         throw new Error( "Unable to set output options" );
      if ( iccProfile != undefined && outputFormat.canStoreICCProfiles ) writer.iccProfile = iccProfile;
      if ( keywords != undefined ) writer.keywords = keywords;
      if ( metadata != undefined && outputFormat.canStoreMetadata ) writer.metadata = metadata;
      if ( thumbnail != undefined && outputFormat.canStoreThumbnails ) writer.thumbnail = thumbnail;
      for ( let property of properties )
         writer.writeImageProperty( property.id, property.value, property.type );
      if ( !writer.writeImage( image ) )
         throw new Error( "Unable to write image data" );
      writer.close();
      image.free();

      if ( File.exists( outputPath ) )
         File.remove( outputPath );
      File.move( temporaryPath, outputPath );
      this.record( sourcePath, outputPath, "converted", this.codec );
   }

   run()
   {
      let outputFormat = new FileFormat( OUTPUT_EXTENSION, false/*toRead*/, true/*toWrite*/ );
      if ( outputFormat.isNull )
         throw new Error( "No installed file format can write XISF files" );
      let files = this.collectFiles();
      console.show();
      console.writeln( "<end><cbr><br>" + TITLE + ": " + files.length + " files, codec " + this.codec );
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
      this.inputList.setMinSize( 600, 250 );

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

      this.codecLabel = new Label( this );
      this.codecLabel.text = "Compression:";
      this.codecLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.codecCombo = new ComboBox( this );
      for ( let codec of CODECS )
         this.codecCombo.addItem( codec );
      this.codecCombo.currentItem = Math.max( 0, CODECS.indexOf( engine.codec ) );
      this.codecCombo.onItemSelected = ( index ) => { engine.codec = CODECS[index]; };

      this.optionsSizer = new HorizontalSizer;
      this.optionsSizer.spacing = 6;
      this.optionsSizer.add( this.recursiveCheck );
      this.optionsSizer.add( this.overwriteCheck );
      this.optionsSizer.addStretch();
      this.optionsSizer.add( this.extensionsLabel );
      this.optionsSizer.add( this.extensionsEdit );
      this.optionsSizer.add( this.codecLabel );
      this.optionsSizer.add( this.codecCombo );

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
      this.sizer.add( this.optionsSizer );
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
   for ( let argument of scriptArguments() )
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
      if ( options.extensions ) engine.extensions = parseSuffixes( options.extensions );
      if ( options.overwrite ) engine.overwriteExisting = options.overwrite == "true";
      if ( CODECS.indexOf( engine.codec ) < 0 )
         throw new Error( "Unknown codec " + engine.codec + ", expected one of " + CODECS.join( ", " ) );
      engine.run();
      return;
   }

   let dialog = new ConversionDialog( engine );
   if ( dialog.execute() )
      engine.run();
}

main();
