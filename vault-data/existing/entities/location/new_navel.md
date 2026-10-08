---
marker:
  - mapName: langdale-stronghold-area-map
    coordinates: "287, 1188"
    icon: lucide-map-pin
    colour: "#dddddd"
  - mapName: langdale-region-map
    coordinates: "731, 835"
    icon: lucide-map-pin
    colour: "#dddddd"
---

```base
filters: file.hasProperty("marker")
views:
  - type: leaflet-map
    name: Map
    mapName: new-navel-map
    image: images/navel.png
    height: 500
    minZoom: -2
    maxZoom: 2
    defaultZoom: -1
    zoomDelta: 0.25
```
