// Load opencascade.js dynamically
import {
  SolidTaskRequest,
  SolidTaskResponse,
  ExtrudeProfileResponseData,
  FeatureEvalOp,
  MeshResult,
} from './SolidEngine.types';
import type { SketchProfile, ProfileSegment } from '../../types/cad';

let oc: any = null;
let currentSolid: any = null; // Store the current solid compound for evaluation and export

async function initWorker(wasmBuffer?: ArrayBuffer) {
  if (!oc) {
    if (wasmBuffer) {
      (self as any).opencascade = {
        wasmBinary: wasmBuffer,
      };
    } else {
      (self as any).opencascade = {
        locateFile: (path: string, _prefix: string) => {
          return new URL(`/occ/${path}`, self.location.origin).href;
        },
      };
    }

    if (typeof (self as any).importScripts === 'function') {
      (self as any).importScripts('/occ/opencascade.wasm.js');
      oc = await (self as any).initOpenCascade((self as any).opencascade);
    } else {
      const response = await fetch('/occ/opencascade.wasm.js');
      const text = await response.text();
      // eslint-disable-next-line no-eval
      eval(text);
      oc = await (self as any).initOpenCascade((self as any).opencascade);
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
      if (mkEdge.IsDone()) {
        wireMaker.Add_1(mkEdge.Edge());
      }
      mkEdge.delete();
    } else if (seg.type === 'arc' && seg.center && seg.radius) {
      const center = new occ.gp_Pnt_3(seg.center.x, seg.center.y, 0);
      const dir = new occ.gp_Dir_4(0, 0, 1);
      const ax2 = new occ.gp_Ax2_3(center, dir);
      const circle = new occ.gp_Circ_2(ax2, seg.radius);

      const sense = seg.sweepFlag !== undefined ? seg.sweepFlag === 1 : true;
      const mkArc = new occ.GC_MakeArcOfCircle_4(circle, p1, p2, sense);
      if (mkArc.IsDone()) {
        const mkEdge = new occ.BRepBuilderAPI_MakeEdge_24(mkArc.Value());
        if (mkEdge.IsDone()) {
          wireMaker.Add_1(mkEdge.Edge());
        }
        mkEdge.delete();
      }
      mkArc.delete();
      circle.delete();
      ax2.delete();
      dir.delete();
      center.delete();
    }
    p1.delete();
    p2.delete();
  }

  const wire = wireMaker.Wire();
  wireMaker.delete();
  return wire;
}

function buildWireFromPoints(points: { x: number; y: number }[], occ: any) {
  const wireMaker = new occ.BRepBuilderAPI_MakeWire_1();
  const len = points.length;
  for (let i = 0; i < len; i++) {
    const pt1 = points[i];
    const pt2 = points[(i + 1) % len];
    const p1 = new occ.gp_Pnt_3(pt1.x, pt1.y, 0);
    const p2 = new occ.gp_Pnt_3(pt2.x, pt2.y, 0);
    const mkEdge = new occ.BRepBuilderAPI_MakeEdge_1(p1, p2);
    if (mkEdge.IsDone()) {
      wireMaker.Add_1(mkEdge.Edge());
    }
    mkEdge.delete();
    p1.delete();
    p2.delete();
  }
  const wire = wireMaker.Wire();
  wireMaker.delete();
  return wire;
}

function createFaceFromProfile(profile: SketchProfile, occ: any) {
  // 1. Build Outer Wire
  let outerWire: any;
  if (profile.segments && profile.segments.length > 0) {
    outerWire = buildWireFromSegments(profile.segments, occ);
  } else if (profile.outerLoop && profile.outerLoop.length > 1) {
    outerWire = buildWireFromPoints(profile.outerLoop, occ);
  } else {
    throw new Error(`Profile ${profile.id || ''} has no valid segments or outer loop`);
  }

  // 2. Build Face
  const faceMaker = new occ.BRepBuilderAPI_MakeFace_15(outerWire, true);

  // 3. Build Inner Wires (Holes)
  if (profile.innerSegments && profile.innerSegments.length > 0) {
    for (const innerSegs of profile.innerSegments) {
      if (innerSegs.length > 0) {
        const innerWire = buildWireFromSegments(innerSegs, occ);
        faceMaker.Add(innerWire);
        innerWire.delete();
      }
    }
  } else if (profile.innerLoops && profile.innerLoops.length > 0) {
    for (const innerLoop of profile.innerLoops) {
      if (innerLoop.length > 1) {
        const innerWire = buildWireFromPoints(innerLoop, occ);
        faceMaker.Add(innerWire);
        innerWire.delete();
      }
    }
  }

  const face = faceMaker.Face();

  // Clean up
  outerWire.delete();
  faceMaker.delete();

  return face;
}

/**
 * Converts a 2D sketch profile into a 3D transformed solid.
 * Performs face creation, local Z-extrusion, local direction shift, and affine 4x4 spatial alignment to the 3D datum plane.
 */
function createTransformedSolid(op: FeatureEvalOp, occ: any): any {
  if (!op.profiles || op.profiles.length === 0) {
    throw new Error(`Feature ${op.featureId || ''} has no profiles to extrude`);
  }

  const depth = typeof op.depth === 'number' && !isNaN(op.depth) ? op.depth : 10;
  const transformedSolids: any[] = [];

  for (const profile of op.profiles) {
    const face = createFaceFromProfile(profile, occ);

    // 1. Local extrusion along Z-axis (0, 0, depth)
    const vec = new occ.gp_Vec_4(0, 0, depth);
    const prismMaker = new occ.BRepPrimAPI_MakePrism_1(face, vec, false, true);
    let localSolid = prismMaker.Shape();

    // Clean up face, vector, and prism maker
    face.delete();
    vec.delete();
    prismMaker.delete();

    // 2. Local direction offset shift
    if (op.direction === 'mid-plane') {
      const trsfMid = new occ.gp_Trsf_1();
      const vecMid = new occ.gp_Vec_4(0, 0, -depth / 2);
      trsfMid.SetTranslation_1(vecMid);
      const xformMid = new occ.BRepBuilderAPI_Transform_2(localSolid, trsfMid, true);
      const shiftedSolid = xformMid.Shape();

      localSolid.delete();
      trsfMid.delete();
      vecMid.delete();
      xformMid.delete();

      localSolid = shiftedSolid;
    } else if (op.direction === 'reversed') {
      const trsfRev = new occ.gp_Trsf_1();
      const vecRev = new occ.gp_Vec_4(0, 0, -depth);
      trsfRev.SetTranslation_1(vecRev);
      const xformRev = new occ.BRepBuilderAPI_Transform_2(localSolid, trsfRev, true);
      const shiftedSolid = xformRev.Shape();

      localSolid.delete();
      trsfRev.delete();
      vecRev.delete();
      xformRev.delete();

      localSolid = shiftedSolid;
    }

    // 3. Spatial posture alignment (affine transform to 3D sketch plane coordinate system)
    const plane: any = op.plane || {};
    const origin = plane.origin || { x: 0, y: 0, z: 0 };
    const normal = plane.normal || { x: 0, y: 0, z: 1 };
    const xAxis = plane.xAxis || { x: 1, y: 0, z: 0 };

    const fromOrig = new occ.gp_Pnt_3(0, 0, 0);
    const fromNorm = new occ.gp_Dir_4(0, 0, 1);
    const fromXDir = new occ.gp_Dir_4(1, 0, 0);
    const fromAx = new occ.gp_Ax3_3(fromOrig, fromNorm, fromXDir);

    const toOrig = new occ.gp_Pnt_3(origin.x, origin.y, origin.z);
    const toNorm = new occ.gp_Dir_4(normal.x, normal.y, normal.z);
    const toXDir = new occ.gp_Dir_4(xAxis.x, xAxis.y, xAxis.z);
    const toAx = new occ.gp_Ax3_3(toOrig, toNorm, toXDir);

    const alignTrsf = new occ.gp_Trsf_1();
    alignTrsf.SetDisplacement(fromAx, toAx);

    const alignXform = new occ.BRepBuilderAPI_Transform_2(localSolid, alignTrsf, true);
    const transformedSolid = alignXform.Shape();

    // Clean up temporary alignment objects and local solid
    localSolid.delete();
    fromOrig.delete();
    fromNorm.delete();
    fromXDir.delete();
    fromAx.delete();
    toOrig.delete();
    toNorm.delete();
    toXDir.delete();
    toAx.delete();
    alignTrsf.delete();
    alignXform.delete();

    transformedSolids.push(transformedSolid);
  }

  if (transformedSolids.length === 1) {
    return transformedSolids[0];
  }

  // Bundle multiple profiles into a TopoDS_Compound
  const builder = new occ.BRep_Builder();
  const compound = new occ.TopoDS_Compound();
  builder.MakeCompound(compound);

  for (const ts of transformedSolids) {
    builder.Add(compound, ts);
    ts.delete();
  }

  builder.delete();
  return compound;
}

function tessellateSolid(solid: any, occ: any): ExtrudeProfileResponseData {
  if (!solid || solid.IsNull()) {
    return {
      vertices: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  // Incremental mesh
  const mesher = new occ.BRepMesh_IncrementalMesh_2(solid, 0.1, false, 0.5, false);

  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let indexOffset = 0;

  const explorer = new occ.TopExp_Explorer_2(
    solid,
    occ.TopAbs_ShapeEnum.TopAbs_FACE,
    occ.TopAbs_ShapeEnum.TopAbs_SHAPE
  );

  while (explorer.More()) {
    const face = occ.TopoDS.Face_1(explorer.Current());
    const loc = new occ.TopLoc_Location_1();
    const triangulation = occ.BRep_Tool.Triangulation(face, loc);

    if (!triangulation.IsNull()) {
      const tri = triangulation.get();
      const numNodes = tri.NbNodes();
      const numTriangles = tri.NbTriangles();

      const nodeArray = tri.Nodes();

      let normalArray = null;
      if (tri.HasNormals()) {
        normalArray = tri.Normals();
      }

      const trsf = loc.Transformation();

      for (let i = 1; i <= numNodes; i++) {
        const origPnt = nodeArray.Value(i);
        const pnt = origPnt.Transformed(trsf);
        vertices.push(pnt.X(), pnt.Y(), pnt.Z());
        pnt.delete();
        origPnt.delete();

        if (normalArray) {
          const n = normalArray.Value(i);
          normals.push(n.X(), n.Y(), n.Z());
          n.delete();
        } else {
          normals.push(0, 0, 1); // fallback normal
        }
      }

      trsf.delete();

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
      triangulation.delete();
    } else {
      triangulation.delete();
    }

    loc.delete();
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
        await initWorker(req.payload?.wasmBuffer);
        _self.postMessage({ taskId: req.taskId, type: req.type, success: true } as SolidTaskResponse);
        break;
      }

      case 'EVALUATE_FEATURE_TREE': {
        if (!oc) throw new Error('Worker not initialized');

        const operations: FeatureEvalOp[] = req.payload?.operations || [];

        // Clean up previous global solid if present
        if (currentSolid) {
          currentSolid.delete();
          currentSolid = null;
        }

        for (const op of operations) {
          const featureSolid = createTransformedSolid(op, oc);
          if (!featureSolid || featureSolid.IsNull()) {
            continue;
          }

          if (currentSolid === null) {
            // First feature evaluation
            if (op.operation === 'JOIN' || op.type === 'EXTRUDE') {
              currentSolid = featureSolid;
            } else {
              // CUT operation requires an existing base body
              featureSolid.delete();
            }
          } else {
            const isCut = op.operation === 'CUT' || op.type === 'CUT_EXTRUDE';

            if (!isCut) {
              // Boolean Fuse (JOIN)
              const fuse = new oc.BRepAlgoAPI_Fuse_3(currentSolid, featureSolid);
              fuse.Build();
              if (fuse.IsDone()) {
                const newSolid = fuse.Shape();
                currentSolid.delete();
                featureSolid.delete();
                currentSolid = newSolid;
              } else {
                featureSolid.delete();
              }
              fuse.delete();
            } else {
              // Boolean Cut (CUT)
              const cut = new oc.BRepAlgoAPI_Cut_3(currentSolid, featureSolid);
              cut.Build();
              if (cut.IsDone()) {
                const newSolid = cut.Shape();
                currentSolid.delete();
                featureSolid.delete();
                currentSolid = newSolid;
              } else {
                featureSolid.delete();
              }
              cut.delete();
            }
          }
        }

        if (currentSolid) {
          const meshData = tessellateSolid(currentSolid, oc);
          _self.postMessage(
            {
              taskId: req.taskId,
              type: req.type,
              success: true,
              data: meshData,
            } as SolidTaskResponse,
            [meshData.vertices.buffer, meshData.normals.buffer, meshData.indices.buffer]
          );
        } else {
          const emptyMesh: MeshResult = {
            vertices: new Float32Array(0),
            normals: new Float32Array(0),
            indices: new Uint32Array(0),
          };
          _self.postMessage({
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: emptyMesh,
          } as SolidTaskResponse);
        }
        break;
      }

      case 'EXTRUDE_PROFILES':
      case 'EXTRUDE_PROFILE': {
        if (!oc) throw new Error('Worker not initialized');

        const profiles: SketchProfile[] =
          req.type === 'EXTRUDE_PROFILES' ? req.payload.profiles : [req.payload.profile];
        const depth = req.payload.depth;

        if (!profiles || profiles.length === 0) {
          throw new Error('No profiles provided for extrusion');
        }

        // Clean up previous solid if exists
        if (currentSolid) {
          currentSolid.delete();
          currentSolid = null;
        }

        // Create Compound container using BRep_Builder
        const builder = new oc.BRep_Builder();
        const compound = new oc.TopoDS_Compound();
        builder.MakeCompound(compound);

        for (const profile of profiles) {
          const face = createFaceFromProfile(profile, oc);
          const vec = new oc.gp_Vec_4(0, 0, depth);
          const prismMaker = new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true);
          const prismSolid = prismMaker.Shape();

          builder.Add(compound, prismSolid);

          // Clean up intermediate per-profile C++ objects
          face.delete();
          vec.delete();
          prismSolid.delete();
          prismMaker.delete();
        }

        builder.delete();

        // Store the compound as the current solid for subsequent export (STEP / STL)
        currentSolid = compound;

        // Tessellate compound to get triangulated mesh
        const meshData = tessellateSolid(compound, oc);

        _self.postMessage(
          {
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: meshData,
          } as SolidTaskResponse,
          [meshData.vertices.buffer, meshData.normals.buffer, meshData.indices.buffer]
        );
        break;
      }

      case 'EXPORT_STEP': {
        if (!oc || !currentSolid) throw new Error('No solid available to export');

        const unit = req.payload?.unit || 'mm';
        oc.Interface_Static.SetCVal('write.step.unit', unit);

        const stepWriter = new oc.STEPControl_Writer_1();
        const transferResult = stepWriter.Transfer(
          currentSolid,
          oc.STEPControl_StepModelType.STEPControl_AsIs,
          true
        );
        if (transferResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
          stepWriter.delete();
          throw new Error('STEP transfer failed');
        }

        const fileName = `export_${Date.now()}.step`;
        const writeResult = stepWriter.Write(fileName);
        if (writeResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
          stepWriter.delete();
          throw new Error('STEP write failed');
        }

        const stepContent = oc.FS.readFile(fileName, { encoding: 'utf8' });
        oc.FS.unlink(fileName);
        stepWriter.delete();

        _self.postMessage({
          taskId: req.taskId,
          type: req.type,
          success: true,
          data: stepContent,
        } as SolidTaskResponse);
        break;
      }

      case 'EXPORT_STL': {
        if (!oc || !currentSolid) throw new Error('No solid available to export');

        const stlWriter = new oc.StlAPI_Writer();
        stlWriter.ASCIIMode = false; // Binary
        const fileName = `export_${Date.now()}.stl`;
        const result = stlWriter.Write(currentSolid, fileName);
        if (!result) {
          stlWriter.delete();
          throw new Error('STL write failed');
        }

        const stlContent = oc.FS.readFile(fileName);
        oc.FS.unlink(fileName);
        stlWriter.delete();

        _self.postMessage(
          {
            taskId: req.taskId,
            type: req.type,
            success: true,
            data: stlContent,
          } as SolidTaskResponse,
          [stlContent.buffer]
        );
        break;
      }

      default:
        throw new Error(`Unknown task type: ${(req as any).type}`);
    }
  } catch (err: any) {
    _self.postMessage({
      taskId: req.taskId,
      type: req.type,
      success: false,
      error: err.message || 'Unknown error',
    } as SolidTaskResponse);
  }
};
