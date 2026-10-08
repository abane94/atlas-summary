---
marker:
  - mapName: mit-gar-map
    coordinates: "1078, 1092"
    icon: mdi:chess-rook
    colour: "#dddddd"
  - mapName: langdale-region-map
    coordinates: "773, 854"
    icon: lucide-map-pin
    colour: "#dddddd"
---

```base
filters: file.hasProperty("marker")
views:
  - type: leaflet-map
    name: Map
    mapName: langdale-stronghold-area-map
    image: images/langdale-stronghold-area.png
    height: 500
    minZoom: -2
    maxZoom: 2
    defaultZoom: -1.36
    zoomDelta: 0.25
    unit: px
```
