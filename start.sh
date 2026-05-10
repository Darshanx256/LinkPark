#!/bin/bash
# Start Shazam backend in the background
python3 app.py &
# Start main Node.js proxy
node server.js
