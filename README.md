# Tapeline

Body measurements and a body-fat estimate from your camera. You stand in front of it twice, once facing it and once side-on. Tapeline tracks your body with MediaPipe:
- a segmentation silhouette, drawn as a 3D wireframe mesh
- a 33-point skeleton
- a 478-point face mesh
- 21-point skeletons for each hand

It then measures you like a tailor would.

**What you get:**
- **Circumferences:** neck, chest, waist (narrowest and at the navel), hips, thigh, calf, upper arm and forearm
- **Lengths:** shoulder width, inseam, arm length, and (when visible) hand length and face width
- **Estimated body fat:** a likely range, fat mass and lean mass, BMI, fat-free mass index, waist-to-height and waist-to-hip ratios
- **History:** every scan saved to [`data/history.json`](data/history.json) in this repo, with changes since last time

## Use it

**Live at [raman365.github.io/tapeline](https://raman365.github.io/tapeline/).** Open it in a browser, allow the camera, and scan. There's no server or account: everything runs in your browser.

To run it from a local copy instead, double-click **`start.command`**. It serves the folder on `http://localhost:8321` and opens your browser. You can also start it by hand:

```sh
python3 -m http.server 8321   # then open http://localhost:8321
```

The camera only works over `http://localhost` or HTTPS. The tracking models load from a CDN, so the first run needs an internet connection.

## Doing a scan

1. Fill in **About you**: sex, age, height and weight. Height sets the scale for every measurement, so be exact.
2. Put the camera **level at waist height, 2–3 m away**, so your whole body fits with a little room. An iPhone works as a Mac webcam through Continuity Camera.
3. Wear **fitted clothes, bare feet**, and tie up big hair.
4. Press **Start scan** and follow the spoken prompts:
   - **Front:** face the camera, arms held out and down in an A.
   - **Side:** turn 90°, arms relaxed at your sides.

   Each shot is taken automatically once you're in position and holding still.

No camera handy? Use **Use photos** with a front photo and a side photo taken the same way.

## Saving your history

Every scan is committed to `data/history.json` in this repo. The list has no cap, and it's the same list on every device. **The repo is public, so anyone can read that file**, including weight, body fat and measurements. Photos are never saved.

Saving needs a GitHub token, which you add once on each device you scan with:

1. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Under **Repository access**, choose **Only select repositories** and pick **tapeline**.
3. Under **Permissions**, set **Contents** to **Read and write**, then generate the token.
4. In Tapeline, open **Settings**, paste the token under **Scan history on GitHub**, and press **Connect**.

The token is kept only in that browser, never in the repo. Visitors without it can use the app, but their scans aren't saved and they don't see your history. Scans saved in a browser by an earlier version are moved into the file the first time you connect there.

The app commits to `main`, so run `git pull` before pushing code changes from your computer.

## How it works

- Your entered height divided by your height in pixels gives the scale in cm per pixel.
- The **front** silhouette gives the width of each body part and the **side** silhouette gives its depth. Each circumference is the perimeter of an ellipse with that width and depth.
- Levels are placed from the skeleton: the chest a quarter of the way from shoulders to hips, the navel about a quarter of the way up from the hip joints, and so on. Each value is the median of about a dozen frames.
- Body fat is a weighted blend of three published formulas:
  - **US Navy tape method** (Hodgdon & Beckett): neck and waist, plus hips for women. 50%.
  - **Relative fat mass** (Woolcott & Bergman): height and waist. 30%.
  - **BMI-based** (Deurenberg): weight, height, age and sex. 20%.
- **Calibration:** measure your waist at the navel with a real tape and enter it on the results screen. Every circumference is then scaled to match, now and in future scans.

## Accuracy, honestly

These are estimates. Tape-based body-fat formulas differ from a DEXA scan by a few percentage points on their own, and camera measurements add error on top of that. Loose clothing, hair, posture, and a camera that isn't level all push numbers up. Use the range, calibrate with a tape if you can, and compare scans taken the same way over time.

Everything runs in your browser. Photos never leave your device. Only the numbers are saved, to the history file described above.

## Files

- `js/body.js`: silhouette measuring, circumferences, body-fat formulas, pose checks
- `js/vision.js`: MediaPipe pose + segmentation, and face and hand tracking on zoomed crops
- `js/render.js`: wireframe body mesh, skeleton, face mesh, hands, tape-measure rings and height tape
- `js/main.js`: camera, guided scan, results screen, history, units
- `js/history.js`: reads and writes `data/history.json` through GitHub's API
- `js/filter.js`: One Euro landmark smoothing
