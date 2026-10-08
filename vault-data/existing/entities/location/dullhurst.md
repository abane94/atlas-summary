---
marker:
  - mapName: mit-gar-map
    coordinates: "1016, 1163"
    icon: lucide-map-pin
    colour: "#dddddd"
---

```base
filters: file.hasProperty("marker")
views:
  - type: leaflet-map
    name: Map
    mapName: dullhurst-map
    image: images/dullhurst.png
    height: 500
    minZoom: -2
    maxZoom: 2
    defaultZoom: -1
    zoomDelta: 0.25
    unit: px
```
