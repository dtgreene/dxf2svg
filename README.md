# dxf2svg

A small browser tool that converts DXF drawings to SVG, joining loose segments into connected, closed paths along the way.

**[Try it here](https://dtgreene.github.io/dxf2svg/)**. Files are processed in your browser and never uploaded.

This isn't a full DXF converter. It handles the 2D geometry in a drawing and leaves the rest out.

## What it does

- Joins endpoints that fall within a set distance, and closes paths that meet back at their start
- Merges segments shorter than a set length
- Keeps true arcs as arcs, while ellipses and splines become short straight lines
- Exports at 1:1 scale when the file gives a usable unit (mm, cm or in), with one SVG group per layer

## Supported

- **Entities:** `LINE`, `ARC`, `CIRCLE`, `ELLIPSE`, `SPLINE`, `LWPOLYLINE`, `POLYLINE` and `INSERT` (blocks)
- **Format:** ASCII DXF only, so re-save binary files as ASCII first

Anything else, such as text, dimensions and hatches, is left out. The app shows what it skipped after loading a file.

## Development

```
npm install
npm run dev
```
