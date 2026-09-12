// Load opencascade.js dynamically
import { SolidTaskRequest, SolidTaskResponse, ExtrudeProfileResponseData } from './SolidEngine.types';
import type { SketchProfile, ProfileSegment } from '../../types/cad';

let oc: any = null;
let currentSolid: any = null; // Store the current solid for exporting

async function initWorker() {
  if (!oc) {
    if (typeof (self as any).importScripts === 'function') {
      (self as any).importScripts('/occ/opencascade.wasm.js');
      oc = await (self as any).initOpenCascade();
    } else {
      // Fallback for some module workers (though importScripts might not exist)
      // Actually, if we use classic worker, importScripts is available.
      // Or we can fetch and eval it.
      const response = await fetch('/occ/opencascade.wasm.js');
      const text = await response.text();
      // eslint-disable-next-line no-eval
      eval(text);
      oc = await (self as any).initOpenCascade();
    }
  }
}

function buildWireFromSegments(segments: ProfileSegment[], occ: any) {
  const wireMaker = new occ.BRepBuilderAPI_MakeWire_1();
  
  for (const seg of segments) {
    const p1 = new occ.gp_Pnt_3(seg.start.x, seg.start.y, 0);
    const p2 = new occ.gp_Pnt_3(seg.end.x, seg.end.y, 0);

    if (seg.type === 'line') {
      const mkEdge = new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
      wireMaker.Add_1(mkEdge.Edge());
      mkEdge.delete();
    } else if (seg.type === 'arc' && seg.center && seg.radius) {
      // Create arc
      const center = new occ.gp_Pnt_3(seg.center.x, seg.center.y, 0);
      const dir = new occ.gp_Dir_4(0, 0, 1);
      const ax2 = new occ.gp_Ax2_3(center, dir);
      const circle = new occ.gp_Circ_2(ax2, seg.radius);

      // OCC arcs go counter-clockwise
      const mkArc = new occ.GC_MakeArcOfCircle_4(circle, p1, p2, true); 
      if (mkArc.IsDone()) {
        const mkEdge = new occ.BRepBuilderAPI_MakeEdge_24(mkArc.Value());
        wireMaker.Add_1(mkEdge.Edge());
        mkEdge.delete();
      }
      mkArc.delete();
      circle.delete();
      ax2.delete();
      dir.delete();
    }
    p1.delete();
    p2.delete();
  }

  const wire = wireMaker.Wire();
  wireMaker.delete();
  return wire;
}

function buildWireFromProfile(profile: SketchProfile, occ: any) {
  return buildWireFromSegments(profile.segments, occ);
}

function extrudeProfile(profile: SketchProfile, depth: number, occ: any) {
  // 1. Build Outer Wire
  const outerWire = buildWireFromProfile(profile, occ);
  
  // 2. Build Face
  const faceMaker = new occ.BRepBuilderAPI_MakeFace_15(outerWire, true);
  
  // 3. Build Inner Wires (Holes)
  if (profile.innerSegments && profile.innerSegments.length > 0) {
    for (const innerSegs of profile.innerSegments) {
      const innerWire = buildWireFromSegments(innerSegs, occ);
      faceMaker.Add(innerWire);
      innerWire.delete();
    }
  }

  const face = faceMaker.Face();
  
  // 4. Extrude Prism
  const vec = new occ.gp_Vec_4(0, 0, depth);
  const prismMaker = new occ.BRepPrimAPI_MakePrism_1(face, vec, false, true);
  const solid = prismMaker.Shape();
  
  // Clean up
  outerWire.delete();
  faceMaker.delete();
  face.delete();
  vec.delete();
  prismMaker.delete();
  
  return solid;
}

function tessellateSolid(solid: any, occ: any): ExtrudeProfileResponseData {
  // Incremental mesh
  const mesher = new occ.BRepMesh_IncrementalMesh_2(solid, 0.1, false, 0.5, false);
  
  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let indexOffset = 0;

  const explorer = new occ.TopExp_Explorer_2(solid, occ.TopAbs_ShapeEnum.TopAbs_FACE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE);
  
  while (explorer.More()) {
    const face = occ.TopoDS.Face_1(explorer.Current());
    const loc = new occ.TopLoc_Location_1();
    const triangulation = occ.BRep_Tool.Triangulation(face, loc);
    
    if (!triangulation.IsNull()) {
      const tri = triangulation.get();
      const numNodes = tri.NbNodes();
      const numTriangles = tri.NbTriangles();
      
      const nodeArray = tri.Nodes();
      
      // We will need normal for each node
      let normalArray = null;
      if (tri.HasNormals()) {
          normalArray = tri.Normals();
      }

      for (let i = 1; i <= numNodes; i++) {
        const pnt = nodeArray.Value(i).Transformed(loc.Transformation());
        vertices.push(pnt.X(), pnt.Y(), pnt.Z());
        pnt.delete();
        
        if (normalArray) {
           const n = normalArray.Value(i);
           normals.push(n.X(), n.Y(), n.Z());
           n.delete();
        } else {
           normals.push(0, 0, 1); // fallback
        }
      }
      
      const triangleArray = tri.Triangles();
      const faceOrientation = face.Orientation();
      const reverse = faceOrientation === occ.TopAbs_Orientation.TopAbs_REVERSED;
      
      for (let i = 1; i <= numTriangles; i++) {
        const triangle = triangleArray.Value(i);
        const n1 = triangle.Value(1);
        const n2 = triangle.Value(2);
        const n3 = triangle.Value(3);
        
        if (reverse) {
            indices.push(indexOffset + n1 - 1, indexOffset + n3 - 1, indexOffset + n2 - 1);
        } else {
            indices.push(indexOffset + n1 - 1, indexOffset + n2 - 1, indexOffset + n3 - 1);
        }
        triangle.delete();
      }
      
      indexOffset += numNodes;
      
      nodeArray.delete();
      triangleArray.delete();
      if (normalArray) normalArray.delete();
    }
    
    loc.delete();
    face.delete();
    explorer.Next();
  }
  
  mesher.delete();
  explorer.delete();
  
  const vArray = new Float32Array(vertices);
  const nArray = new Float32Array(normals);
  const iArray = indexOffset > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  
  return { vertices: vArray, normals: nArray, indices: iArray };
}

const _self = self as any;

_self.onmessage = async (e: MessageEvent<SolidTaskRequest>) => {
  const req = e.data;
  
  try {
    switch (req.type) {
      case 'INIT': {
        await initWorker();
        _self.postMessage({ taskId: req.taskId, type: req.type, success: true } as SolidTaskResponse);
        break;
      }
      case 'EXTRUDE_PROFILE': {
        if (!oc) throw new Error('Worker not initialized');
        const { profile, depth } = req.payload;
        
        // Clean up previous solid if exists
        if (currentSolid) {
            currentSolid.delete();
            currentSolid = null;
        }

        const solid = extrudeProfile(profile, depth, oc);
        currentSolid = solid; // Store for export
        const meshData = tessellateSolid(solid, oc);
        
        _self.postMessage({
          taskId: req.taskId,
          type: req.type,
          success: true,
          data: meshData
        } as SolidTaskResponse, [meshData.vertices.buffer, meshData.normals.buffer, meshData.indices.buffer]);
        break;
      }
      case 'EXPORT_STEP': {
        if (!oc || !currentSolid) throw new Error('No solid available to export');
        
        const stepWriter = new oc.STEPControl_Writer_1();
        const transferResult = stepWriter.Transfer(currentSolid, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
        if (transferResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
            throw new Error('STEP transfer failed');
        }
        
        const fileName = 'export.step';
        const writeResult = stepWriter.Write(fileName);
        if (writeResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
            throw new Error('STEP write failed');
        }
        
        const stepContent = oc.FS.readFile(fileName, { encoding: 'utf8' });
        oc.FS.unlink(fileName);
        stepWriter.delete();
        
        _self.postMessage({
          taskId: req.taskId,
          type: req.type,
          success: true,
          data: stepContent
        } as SolidTaskResponse);
        break;
      }
      case 'EXPORT_STL': {
        if (!oc || !currentSolid) throw new Error('No solid available to export');
        
        const stlWriter = new oc.StlAPI_Writer();
        stlWriter.ASCIIMode = false; // Binary
        const fileName = 'export.stl';
        const result = stlWriter.Write(currentSolid, fileName);
        if (!result) {
            throw new Error('STL write failed');
        }
        
        const stlContent = oc.FS.readFile(fileName);
        oc.FS.unlink(fileName);
        stlWriter.delete();
        
        // stlContent is a Uint8Array
        _self.postMessage({
          taskId: req.taskId,
          type: req.type,
          success: true,
          data: stlContent
        } as SolidTaskResponse, [stlContent.buffer]);
        break;
      }
      default:
        throw new Error(`Unknown task type: ${req.type}`);
    }
  } catch (err: any) {
    _self.postMessage({
      taskId: req.taskId,
      type: req.type,
      success: false,
      error: err.message || 'Unknown error'
    } as SolidTaskResponse);
  }
};
