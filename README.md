<p align="center">
  <img src="logo.webp" alt="LinkPark Logo" width="250" />
</p>

You send a Spotify link to a friend. They reply "I don't have Spotify." You roll your eyes. That's why LinkPark exists. 

LinkPark takes a track, it could be a messy URL you copied from an app or just a few lyrics you vaguely remember, then figures out exactly what song it is. It then spits out clean, tracker-free links for every major streaming platform so you can actually share music without the back-and-forth.

It handles the heavy lifting in the background by juggling the Odesli, Tinyfish, and iTunes APIs simultaneously. It purposely scrubs out those annoying tracking parameters (like `?si=` or `&mt=`) before giving you the final URLs. There's also a native 30-second audio preview player built right in so you know you found the right version.

What's different here? With all the available APIs (Odesli, Tinyfish, and Apple Music), I have made sure it almost always provides links for the "Big 3" (Spotify, YouTube Music, and Apple Music) which Odesli often fails to provide! ;D

### How to use it

### Deployment & Local Setup

LinkPark is flexible. You can run it in three different ways depending on how much you care about API key security and pain:

#### 1. The Standalone Server (Recommended for zero-effort hosting)
If you want to host everything in one place (like on Render, Vercel, or a VPS), just point your hosting service to this repository.
- The `server.js` acts as both the web server and a secure API proxy.
- **Setup**: 
  - Add `TFKEY` to your environment variables.
  - Set `PROXY = '/api/search'` in `index.html` and push.
  - Your API key stays safe on the server and is never seen by the browser.

#### 2. The Hybrid Way (GitHub Pages + External Proxy)
You can keep the frontend on GitHub Pages and host the proxy elsewhere.
- **Setup**: 
  - Deploy the `server.js` to a service like Vercel or Render.
  - Add `TFKEY` and `SERVICE` (your GitHub Pages URL) to that service's environment variables.
  - Set `PROXY = 'https://your-proxy-url.com/api/search'` in `index.html` and push.
- This is great if you want to keep the "static" feel of GitHub Pages but still want a secure key.

#### 3. Least pain (Local Development)
Perfect for testing things out on your machine without setting up a server.
- **Setup**:
  - Clone the folder.
  - Create a `config.js` in the root:
    ```javascript
    window.LINKPARK_CONFIG = { TFKEY: "your_key_here" };
    ```
  - Leave `PROXY = ''` in `index.html`.
  - Open `index.html` in your browser. (Note: Search might fail in some browsers due to CORS if run directly from a file).

👉 **[Live Demo: LinkPark](https://darshanx256.github.io/LinkPark/)**

### What it uses under the hood

- **Frontend**: Plain HTML, CSS, and Vanilla JavaScript.
- **Primary Resolution**: Odesli API
- **Deep Search**: Tinyfish API
- **Metadata & Audio Previews**: iTunes Search API

### Design
The LinkPark logo uses the **OpenSans** font. 

*License: Standard open-source terms.*
