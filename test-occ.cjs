const initOpenCascade = require('opencascade.js');
initOpenCascade().then(occ => {
  console.log("BRepBuilderAPI_MakeWire:", !!occ.BRepBuilderAPI_MakeWire);
  console.log("BRepBuilderAPI_MakeWire_1:", !!occ.BRepBuilderAPI_MakeWire_1);
  console.log("BRepBuilderAPI_MakeEdge:", !!occ.BRepBuilderAPI_MakeEdge);
  console.log("BRepBuilderAPI_MakeEdge_1:", !!occ.BRepBuilderAPI_MakeEdge_1);
  console.log("BRepBuilderAPI_MakeFace_15:", !!occ.BRepBuilderAPI_MakeFace_15);
  console.log("BRepBuilderAPI_MakeFace_1:", !!occ.BRepBuilderAPI_MakeFace_1);
  console.log("BRepBuilderAPI_MakeFace:", !!occ.BRepBuilderAPI_MakeFace);
  console.log("BRepPrimAPI_MakePrism:", !!occ.BRepPrimAPI_MakePrism);
  console.log("BRepPrimAPI_MakePrism_1:", !!occ.BRepPrimAPI_MakePrism_1);
  console.log("BRepMesh_IncrementalMesh:", !!occ.BRepMesh_IncrementalMesh);
  console.log("BRepMesh_IncrementalMesh_2:", !!occ.BRepMesh_IncrementalMesh_2);
  console.log("GC_MakeArcOfCircle_4:", !!occ.GC_MakeArcOfCircle_4);
  console.log("GC_MakeArcOfCircle:", !!occ.GC_MakeArcOfCircle);
});
