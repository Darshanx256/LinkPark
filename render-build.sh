#!/usr/bin/env bash
# Exit on error
set -o errexit

# Install Node dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt
