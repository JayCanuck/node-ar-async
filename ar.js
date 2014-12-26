/*
 * The MIT License (MIT)
 * 
 * node-ar-async Copyright (c) 2014 Jason Robitaille.
 * https://github.com/JayCanuck/node-ar-async
 * 
 * Based on, and including code from, from node-ar, Copyright (c) 2013 John Vilk.
 * https://github.com/jvilk/node-ar
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:

 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.

 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var fs = require('fs');
var path = require('path');

function ArReader(file) {
	EventEmitter.call(this);
	this.file = file;
	var self = this;
	fs.stat(this.file, function(sErr, stats) {
		if(sErr) {
			self.emit("error", sErr);
		} else {
			self.size = stats.size;
			fs.open(self.file, "r", function(oErr, fd) {
				if(oErr) {
					self.emit("error", oErr);
				} else {
					self.emit("open");
					self.fd = fd;
					var readChunks = function(buf, off, pos, left, cb) {
						if(pos>=self.size && left>0) {
							cb();
						} else if(left<=0) {
							cb(buf);
						} else {
							var chunkSize = Math.max(Math.min(left, 1024), 0);
							fs.read(fd, buf, off, chunkSize, pos, function(rErr, read, b) {
								if(rErr) {
									self.emit("error", rErr);
									cb();
								} else {
									readChunks(buf, off+read, pos+read, left-read, cb);
								}
							});
						}
					};
					var readEntry = function(offset) {
						readChunks(new Buffer(60), 0, offset, 60, function(header) {
							if(!header) {
								self.emit("end");
								fs.close(fd, function(cErr) {
									if(cErr) {
										self.emit("error", cErr);
									}
									self.fd = undefined;
									self.emit("close");
								});
							} else {
								var entry = new ArEntry(header, self);
								var bsdNameSize = entry.nameSizeBSD();
								readChunks(new Buffer(bsdNameSize), 0, offset+60, bsdNameSize, function(bsdNameData) {
									if(bsdNameData) {
										entry.bsdName = trimNulls(bsdNameData.toString('utf8', 0, bsdNameSize));
										var nextOffset = entry.totalSize()+offset;
										var nexted = false;
										var next = function() {
											if(!nexted) { //prevent repeat calls
												entry = undefined;
												readEntry(nextOffset);
												nexted = true;
											}
										};
										if(entry.name()==="//") {
											self.gnuEntry = entry;
											var size = entry.fileSize();
											readChunks(new Buffer(size), 0, offset+60+bsdNameSize, size, function(gnuData) {
												self.gnuEntry.data = gnuData;
												next();
											});
										} else {
											entry.streamParam = {
												file: self.file,
												start: offset+60+bsdNameSize,
												end: offset+60+entry.dataSize()-1
											};
											self.emit("entry", entry, next);
										}
									}
								});
							}
						});
					};
					readEntry(8);
				}
			});
		}
	});
}
util.inherits(ArReader, EventEmitter);

ArReader.prototype.isGNU = function() {
	return (this.gnuEntry!==undefined);
};

ArReader.prototype.resolveNameGNU = function(shortName) {
	if(this.isGNU()) {
		try {
			var start = parseInt(shortName.replace("/", ""), 10);
			var resolved = this.gnuEntry.data.toString('utf8', start);
			return resolved.substring(0, resolved.indexOf("\n"));
		} catch(e) {
			return shortName;
		}
		
	}
};

/**
* Given something of size *size* bytes that needs to be aligned by *alignment*
* bytes, returns the total number of padding bytes that need to be appended to
* the end of the data.
*/
function getPaddingBytes(size, alignment) {
    return (alignment - (size % alignment)) % alignment;
}

function padWhitespace(str, width) {
	while(str.length<width) {
		str += " ";
	}
	return str;
}
function padLF(width) {
	var str = "";
	while(str.length<width) {
		str += "\n";
	}
	return str;
}

function strictWidthField(str, width) {
	if(str.length>width) {
		return str.substring(0, width);
	} else {
		return padWhitespace(str, width);
	}
}

/**
* Trims trailing whitespace from the given string (both ends, although we
* only really need the RHS).
*/
function trimWhitespace(str) {
    return String.prototype.trim ? str.trim() : str.replace(/^\s+|\s+$/gm, '');
}

/**
* Trims trailing NULL characters.
*/
function trimNulls(str) {
    return str.replace(/\0/g, '');
}

function buildHeader(name, ts, uid, gid, mode, size) {
	var header = strictWidthField(name, 16)
			+ strictWidthField(ts, 12)
			+ strictWidthField(uid, 6)
			+ strictWidthField(gid, 6)
			+ strictWidthField(mode, 8)
			+ strictWidthField(size, 10)
			+ "`\n";
	return new Buffer(header, "ascii");
}

/**
* All archive variants share this header before files, but the variants differ
* in how they handle odd cases (e.g. files with spaces, long filenames, etc).
*
* char	ar_name[16]; File name
* char	ar_date[12]; file member date
* char	ar_uid[6]	file member user identification
* char	ar_gid[6]	file member group identification
* char	ar_mode[8]   file member mode (octal)
* char	ar_size[10]; file member size
* char	ar_fmag[2];  header trailer string
*/
function ArEntry(header, archive) {
	this.header = header;
	this.archive = archive;
	if(this.fmag() !== "`\n") {
		throw new Error("Record is missing header trailer string; instead, it has: " + this.fmag());
	}
	this.bsd = this.name().substr(0, 3) === "#1/";
}
ArEntry.prototype.name = function () {
	// The name field is padded by whitespace, so trim any lingering whitespace.
	return trimWhitespace(this.header.toString('utf8', 0, 16));
};
ArEntry.prototype.realName = function () {
	var name = this.name();
	if(this.bsd) {
		var length = this.nameSizeBSD();
        // Unfortunately, even though they give us the *explicit length*, they add
        // NULL bytes and include that in the length, so we must strip them out.
        name = this.bsdName;
	} else if(this.archive && this.archive.isGNU() && name.indexOf("/")===0) {
		name = this.archive.resolveNameGNU(name);
	}
	return name;
};
/**
* Returns the number of bytes that the resolved BSD-style name takes up in the 
* content section.
*/
ArEntry.prototype.nameSizeBSD = function () {
	if (this.bsd) {
		return parseInt(this.name().substr(3), 10);
	} else {
		return 0;
	}
};
ArEntry.prototype.fileName = function () {
	var n = this.realName();
	if(n.lastIndexOf("/")==n.length-1) {
		n = n.substring(0, n.length-1);
	}
	return n;
};
ArEntry.prototype.date = function () {
	return new Date(parseInt(this.header.toString('ascii', 16, 28), 10));
};
ArEntry.prototype.uid = function () {
	return parseInt(this.header.toString('ascii', 28, 34), 10);
};
ArEntry.prototype.gid = function () {
	return parseInt(this.header.toString('ascii', 34, 40), 10);
};
ArEntry.prototype.mode = function () {
	return parseInt(this.header.toString('ascii', 40, 48), 8);
};

/**
* Total size of the data section in the record. Does not include padding bytes.
*/
ArEntry.prototype.dataSize = function () {
	return parseInt(this.header.toString('ascii', 48, 58), 10);
};

/**
* Total size of the *file* data in the data section of the record. This is
* not always equal to dataSize.
*/
ArEntry.prototype.fileSize = function () {
	if(this.bsd) {
		return this.dataSize() - this.nameSizeBSD();
	} else {
		return this.dataSize();
	}
};
ArEntry.prototype.fmag = function () {
	return this.header.toString('ascii', 58, 60);
};

/**
* Total size of the header, including padding bytes.
*/
ArEntry.prototype.headerSize = function () {
	// The common header is already two-byte aligned.
	return 60;
};

/**
* Total size of this file record (header + header padding + file data +
* padding before next archive member).
*/
ArEntry.prototype.totalSize = function () {
	var headerSize = this.headerSize(), dataSize = this.dataSize();

	// All archive members are 2-byte aligned, so there's padding bytes after
	// the data section.
	return headerSize + dataSize + getPaddingBytes(dataSize, 2);
};

/**
* Returns a *slice* of the backing buffer that has all of the file's data.
*/
ArEntry.prototype.fileData = function () {
	if(this.streamParam) {
		if(this.archive && this.archive.fd!==undefined) {
			return fs.createReadStream(this.streamParam.file, {
				fd: this.archive.fd,
				autoClose: false,
				start: this.streamParam.start,
				end: this.streamParam.end
			});
		} else {
			return fs.createReadStream(this.streamParam.file, {
				start: this.streamParam.start,
				end: this.streamParam.end
			});
		}
	}
	
};

function ArWriter(file, opts) {
	EventEmitter.call(this);
	this.file = file;
	if(opts) {
		if(opts.variant) {
			opts.variant = opts.variant.toLowerCase();
			if(opts.variant==="bsd") {
				this.bsd = true;
			} else if(opts.variant==="gnu") {
				this.gnu = true;
			}
		}
		if(opts.uid) {
			this.uid = opts.uid;
		}
		if(opts.gid) {
			this.gid = opts.gid;
		}
		if(opts.mode) {
			this.mode = opts.mode;
		}
	}
}
util.inherits(ArWriter, EventEmitter);

ArWriter.prototype.writeEntries = function(entries, callback) {
	var self = this;
	if(fs.existsSync(self.file)) {
		fs.unlinkSync(self.file);
	}
	fs.open(self.file, "w", function(oErr, fd) {
		if(oErr) {
			self.emit("error", oErr);
		} else {
			self.emit("open");
			fs.write(fd, new Buffer("!<arch>\n", "ascii"), 0, 8, null, function(archErr, writ, b) {
				if(archErr) {
					self.emit("error", archErr);
				} else {
					var writeEntry = function(entry, off, cb) {
						fs.write(fd, entry.header, 0, entry.headerSize(), null, function(wErr1, w, b) {
							if(wErr1) {
								self.emit("error", wErr1);
							} else {
								var dataSize = entry.dataSize();
								var paddedData = entry.data;
								var paddSize = getPaddingBytes(dataSize, 2);
								if(paddSize>0) {
									paddedData = Buffer.concat([entry.data,
											new Buffer(padLF(paddSize), "ascii")], dataSize+paddSize);
								}
								fs.write(fd, paddedData, 0, dataSize+paddSize, null, function(wErr2, w2, b2) {
									if(wErr2) {
										self.emit("error", wErr2);
									} else {
										var total = entry.totalSize();
										entry = undefined;
										cb(off+total);
									}
								});
							}
						});
					};
					var processFile = function(fList, off, cb) {
						if(fList.length<=0) {
							cb();
						} else {
							var curr = fList.shift();
							fs.stat(curr, function(statErr, currStat) {
								if(statErr) {
									self.emit("error", statErr);
								} else {
									fs.readFile(curr, function(rfErr, data) {
										if(rfErr) {
											self.emit("error", rfErr);
										} else {
											var currName = path.basename(curr) + "/";
											var currSize = currStat.size;
											if(self.gnu && self.gnuMap[currName]) {
												currName = self.gnuMap[currName];
											} else if(self.bsd && currName.length>16) {
												currSize += currName.length;
												data = Buffer.concat([new Buffer(currName, "ascii"), data], currSize);
												currName = "#1/" + currName.length;

											}
											var currHeader = buildHeader(currName,
													(currStat.mtime.getTime()/1000) + "",
													((self.uid!==undefined) ? self.uid : currStat.uid) + "",
													((self.gid!==undefined) ? self.gid : currStat.gid) + "",
													((self.mode!==undefined) ? self.mode : currStat.mode).toString(8),
													currSize + "");
											var arEntry = new ArEntry(currHeader, self);
											arEntry.data = data;
											writeEntry(arEntry, off, function(newOff) {
												self.emit("entry", arEntry);
												arEntry = undefined;
												processFile(fList, newOff, cb);
											})
										}
									});
								}
							});
						}
					};
					var finished = function() {
						fs.close(fd, function(cwErr) {
							if(cwErr) {
								self.emit("error", cwErr);
							} else {
								self.emit("finish");
								callback && callback();
							}
						});
					};
					if(self.gnu) {
						self.gnuMap = {};
						var gnuContent = "";
						for(var i=0; i<entries.length; i++) {
							var base = path.basename(entries[i]) + "/";
							if(base.length>16) {
								self.gnuMap[base] = "/" + gnuContent.length;
								gnuContent += base + "\n";
							}
						}
						if(Object.keys(self.gnuMap).length>0) {
							var gnuHeader = buildHeader("//", "", "", "", "", gnuContent.length + "");
							self.gnuEntry = new ArEntry(gnuHeader, self);
							self.gnuEntry.data = new Buffer(gnuContent);
							writeEntry(self.gnuEntry, 8, function(newOffset) {
								processFile(entries, newOffset, finished);
							});
						} else {
							processFile(entries, 8, finished);
						}
					} else {
						processFile(entries, 8, finished);
					}
				}
			});
		}
	});
};

ArWriter.prototype.isGNU = function() {
	return this.gnu;
};

ArWriter.prototype.isBSD = function() {
	return this.bsd;
};

ArWriter.prototype.resolveNameGNU = function(shortName) {
	return ArReader.prototype.resolveNameGNU.call(this, shortName);
};

module.exports = {ArReader: ArReader, ArWriter: ArWriter};
