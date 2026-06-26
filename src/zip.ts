import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

export interface ZipEntryInfo {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ExtractZipEntryResult {
  fileName: string;
  outputPath: string;
  bytesWritten: number;
}

export async function listZipEntries(zipPath: string): Promise<ZipEntryInfo[]> {
  return new Promise((resolve, reject) => {
    const entries: ZipEntryInfo[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error("Unable to open ZIP archive"));
        return;
      }

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (!entry.fileName.endsWith("/")) {
          entries.push({
            fileName: entry.fileName,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
          });
        }
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
    });
  });
}

export async function extractZipEntry(
  zipPath: string,
  entryName: string,
  outputPath: string
): Promise<ExtractZipEntryResult> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error("Unable to open ZIP archive"));
        return;
      }

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, async (streamError, readStream) => {
          if (streamError || !readStream) {
            reject(streamError ?? new Error(`Unable to read ZIP entry: ${entryName}`));
            return;
          }
          try {
            await mkdir(path.dirname(outputPath), { recursive: true });
            await pipeline(readStream, createWriteStream(outputPath));
            zipfile.close();
            resolve({
              fileName: entry.fileName,
              outputPath,
              bytesWritten: entry.uncompressedSize,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      zipfile.on("end", () => reject(new Error(`ZIP entry not found: ${entryName}`)));
      zipfile.on("error", reject);
    });
  });
}
