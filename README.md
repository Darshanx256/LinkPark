<p align="center">
  <img src="logo.webp" alt="LinkPark Logo" width="250" />
</p>


You send a Spotify link to a friend. They reply "I don't have Spotify." You roll your eyes. That's why LinkPark exists. 

LinkPark takes a track, it could be a messy URL you copied from an app or just a few lyrics you vaguely remember, then figures out exactly what song it is. It then spits out clean, tracker-free links for every major streaming platform so you can actually share music without the back-and-forth.

It handles the heavy lifting in the background by juggling the Odesli, Tinyfish, and iTunes APIs simultaneously. It purposely scrubs out those annoying tracking parameters (like `?si=` or `&mt=`) before giving you the final URLs. There's also a native 30-second audio preview player built right in so you know you found the right version.

Whats diffrent here? With all the available APIs (Odesli, Tinyfish and Apple Music) I have made sure it almost always provide links for big 3  (Spotify, Youtube Music and Apple Music) which Odesli often fails to provide! ;D

### How to use it

It's just a single HTML file. Either you can run it locally , but you would need to setup Tinyfish API for that, or use the deployed version for less pain:

👉 **[Live Demo: LinkPark](https://darshanx256.github.io/LinkPark/)**

#### I want pain

1. Clone or download this folder.
2. The search engine relies on the Tinyfish API. Create a `config.js` file in the root folder (it's ignored by git) and drop your key in:
   ```javascript
   window.LINKPARK_CONFIG = {
     TFKEY: "your_key_here"
   };
   ```
3. Open `index.html` in a browser. That's it. You can throw it on Vercel or GitHub Pages if you want to host it.

### What it uses under the hood

- **Frontend**: Plain HTML, CSS, and Vanilla JavaScript.
- **Primary Resolution**: Odesli API
- **Deep Search**: Tinyfish API
- **Metadata & Audio Previews**: iTunes Search API

*License: Standard open-source terms.*
