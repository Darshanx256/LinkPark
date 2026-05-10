from fastapi import FastAPI, UploadFile, File
from shazamio import Shazam
import uvicorn
import os

app = FastAPI()
shazam = Shazam()

@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    try:
        content = await file.read()
        out = await shazam.recognize_song(content)
        
        if not out or 'track' not in out:
            return {"status": "error", "message": "Could not identify song."}
            
        track = out['track']
        return {
            "status": "success",
            "song": f"{track['title']} - {track['subtitle']}",
            "title": track['title'],
            "artist": track['subtitle']
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
