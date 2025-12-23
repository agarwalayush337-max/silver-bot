#!/usr/bin/env bash
# exit on error
set -o errexit

npm install

# Install Chrome manually for the Render Native Environment
mkdir -p ./render-chrome
cd ./render-chrome
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
# Extracting instead of installing because Render doesn't allow sudo
dpkg -x google-chrome-stable_current_amd64.deb .
cd ..
