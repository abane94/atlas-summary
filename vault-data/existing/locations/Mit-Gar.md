---
marker:
  - mapName: new-atlas-world-map
    coordinates: "295, 1475"
    icon: lucide-map-pin
    colour: "#dddddd"
---

```base
filters: file.hasProperty("marker")
views:
  - type: leaflet-map
    name: Map
    mapName: mit-gar-map
    image: images/mit-gar.png
    height: 500
    minZoom: -2
    maxZoom: 2
    defaultZoom: -1.51
    zoomDelta: 0.25
    unit: px
```
