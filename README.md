ar
====

A Node library for asynchronously reading and writing [Unix archive files](http://en.wikipedia.org/wiki/Ar_%28Unix%29). Currents supprts basic `ar` format, as well as BSD and GNU variants.

###ArReader
```javascript
var ar = require('ar'),
    fs = require('fs'),
    path = require('path');

// extracts all of the files in "some_archive.a" to the folder "./output".
var outputDir = "./output";
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

var reader = new ar.ArReader("some_archive.a");
reader.on("open", function() {
	// archive opened
});
reader.on("entry", function(entry, next) {
	// entry is an instance of ArEntry
	var name = entry.fileName();
	entry.fileData()
		.pipe(fs.createWriteStream(name))
		.on("finish", next);		
});
reader.on("error", function(err) {
	// archive reading error
});
reader.on("end", function() {
	// archive parsing ended
});
reader.on("close", function() {
	// archive closed
});
```

ArReader automatically detects and handles BSD and GNU variant formats. All events are optional, so you only have to listen for the ones you want.

###ArWriter
```javascript
var ar = require('ar'),
    fs = require('fs'),
    path = require('path');

// write files into a new ar archive at "some_archive.a"
// in the case, specifies gnu variant format for long filenames
var writer = new ar.ArWriter("./some_archive.a", {variant:"gnu"});
writer.writeEntries([
		"./some_file",
		"./some_other_file",
		"./yet_another_file"
	], function() {
		// optional callback after completion
	});
writer.on("open", function() {
	// archive opened
});
writer.on("entry", function(entry) {
	// entry is an instance of ArEntry
	// signifies an entry has been written
	// unlike ArReader, there is no next function
});
writer.on("error", function(err) {
	// archive writing error
});
writer.on("finish", function() {
	// archive writing ended and closed
});
```

ArWriter by default will truncate filenames at 16 bytes long. For long file names, specify a variant format, like done above. Currently "GNU" and "BSD" are supported. Additionally, you can specify "uid", "gid", and "mode" number values in the options json; they will override the values for each file written. All events are optional, so you only have to listen for the ones you want.

###ArEntry
See ar.js for inline ArEntry documention, but here are the key APIs

* [ArEntry].fileName() - String - Filename of the file in the entry
* [ArEntry].fileSize() - Number - Number of bytes the file takes up
* [ArEntry].fileData() - Stream - Readable stream for file data
* [ArEntry].date() - Date - Last modified date of the file
* [ArEntry].uid() - Number - UID of the file
* [ArEntry].gid() - Number - GID of the file
* [ArEntry].mode() - Number - File mode

###License
Licensed under the MIT License (MIT)

node-ar-async Copyright (c) 2014 Jason Robitaille.
https://github.com/JayCanuck/node-ar-async

Based on, and including code from, from node-ar, Copyright (c) 2013 John Vilk.
https://github.com/jvilk/node-ar

