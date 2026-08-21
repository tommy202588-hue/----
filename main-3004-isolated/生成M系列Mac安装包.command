#!/bin/zsh
set -e
cd "$(dirname "$0")"
npm install
node scripts/build-mac-installer.mjs --arch=arm64
open desktop-release-mac
