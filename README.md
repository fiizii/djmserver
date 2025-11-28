### Setup
0. Extract this project into your music directory , whatever contains your track folders / list. It will broadcast any audio file - and the folders containing audio - from the directory it's extracted in.
1. Run `quick.bat`.
2. Run `node index.js`. (First run generates config and exits).
3. Edit `.mrepo/conf.yaml`: set `ready: true` and copy the `key`.
4. Run `node index.js`.

### 2. Host (DevTunnel)
To share your library, expose port 3000 (or whatever port youve set). You **must** use `--allow-anonymous` so its a public share..

```bash
winget install Microsoft.Devtunnels
devtunnel user login
devtunnel host -p 3000 --allow-anonymous
```
*Copy the `https://...` URL provided.*

### 3. Sync
1. Go to `http://localhost:3000/admin`.
2. Login with your `key`.
3. Add Remote: Enter a Name and the DevTunnel URL (of the other source, if you sync your own it wont work.)
4. Click **SYNC**.
5. Enjoy ungatekept music, files will be deduped.

*Syncing happens in the background. Check your terminal for progress bars and logs.*
If you want to make your link public, open an issue with [SHARE] in the subject. <3
