#!/usr/bin/env node
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolve(__dirname, '..', 'dist', 'loader.js')));

await import(pathToFileURL(resolve(__dirname, '..', 'dist', 'index.js')));
