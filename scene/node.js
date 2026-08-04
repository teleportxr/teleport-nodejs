'use strict';
const core= require('../core/core.js');
const resources= require('./resources.js');
//! The payload type, or how to interpret the server's message.
const NodeDataType =
{									
	Invalid:0,		
	None:1,
	Mesh:2,
	Light:3,
	TextCanvas:4,
	SubScene:5,
	Skeleton:6,
	Link:7,
	Script:8,
	AudioEmitter:9		// Reserved. Audio is bound via the track SDP mid = emitting node uid; not carried in the node payload.
};

//! Wire size of teleport::core::Pose_packed: vec4 orientation then vec3 position.
//! NB: this is NOT Pose.sizeof(), which is the 40-byte unpacked transform (position,
//! orientation, scale) written into the Node payload. The packed form carries no scale.
const POSE_PACKED_SIZE = 28;
//! Wire size of teleport::core::PoseDynamic_packed: Pose_packed then vec3 velocity
//! then vec3 angularVelocity.
const POSE_DYNAMIC_PACKED_SIZE = POSE_PACKED_SIZE + (3*4) + (3*4);	// 52
//! Wire size of teleport::core::NodePose: uid then PoseDynamic_packed.
const NODE_POSE_SIZE = 8 + POSE_DYNAMIC_PACKED_SIZE;				// 60

class Pose
{
    constructor()
    {
		this.orientation = { x:0.0, y:0.0, z:0.0, w:1.0 };
		this.position = { x:0.0, y:0.0, z:0.0 };
		this.scale = { x:1.0, y:1.0, z:1.0 };
	}
    static sizeof(){
        return 4*4+(3*4)+(3*4);
    }
    size(){
        return Pose.sizeof();
    }
	encodeIntoDataView(dataView,byteOffset) {
		dataView.setFloat32(byteOffset+0,this.position.x,core.endian);
		dataView.setFloat32(byteOffset+4,this.position.y,core.endian);
		dataView.setFloat32(byteOffset+8,this.position.z,core.endian);
		dataView.setFloat32(byteOffset+12,this.orientation.x,core.endian);
		dataView.setFloat32(byteOffset+16,this.orientation.y,core.endian);
		dataView.setFloat32(byteOffset+20,this.orientation.z,core.endian);
		dataView.setFloat32(byteOffset+24,this.orientation.w,core.endian);
		dataView.setFloat32(byteOffset+28,this.scale.x,core.endian);
		dataView.setFloat32(byteOffset+32,this.scale.y,core.endian);
		dataView.setFloat32(byteOffset+36,this.scale.z,core.endian);
		return byteOffset+40;
	}
	encodeToUint8Array(){
		var array=new Uint8Array(this.size());
		var dataView=new DataView(array.buffer);
		this.encodeIntoDataView(dataView);
		return array;
	}
	decodeOrientationPositionFromDataView( dataView, byteOffset) {
		this.orientation.x = dataView.getFloat32(byteOffset, core.endian);
		this.orientation.y = dataView.getFloat32(byteOffset+4, core.endian);
		this.orientation.z = dataView.getFloat32(byteOffset+8, core.endian);
		this.orientation.w = dataView.getFloat32(byteOffset+12, core.endian);
		this.position.x = dataView.getFloat32(byteOffset+16, core.endian);
		this.position.y = dataView.getFloat32(byteOffset+20, core.endian);
		this.position.z = dataView.getFloat32(byteOffset+24, core.endian);
		return byteOffset+POSE_PACKED_SIZE;
	}
};

//! A pose with its linear and angular velocity. Extends Pose so that position,
//! orientation and scale are members of this object: the decode and encode paths
//! below address them directly, and before this was a subclass they resolved to
//! undefined (nothing exercised them, so it went unnoticed).
class PoseDynamic extends Pose
{
	constructor(){
		super();
		this.velocity={x:0.0, y:0.0, z:0.0 };
		this.angularVelocity={x:0.0, y:0.0, z:0.0 };
	}
    static sizeof(){
        return Pose.sizeof()+(3*4)+(3*4);
    }
    size(){
        return PoseDynamic.sizeof();
    }
	encodeIntoDataView(dataView,byteOffset) {
		dataView.setFloat32(byteOffset+0,this.position.x,core.endian);
		dataView.setFloat32(byteOffset+4,this.position.y,core.endian);
		dataView.setFloat32(byteOffset+8,this.position.z,core.endian);
		dataView.setFloat32(byteOffset+12,this.orientation.x,core.endian);
		dataView.setFloat32(byteOffset+16,this.orientation.y,core.endian);
		dataView.setFloat32(byteOffset+20,this.orientation.z,core.endian);
		dataView.setFloat32(byteOffset+24,this.orientation.w,core.endian);
		dataView.setFloat32(byteOffset+28,this.scale.x,core.endian);
		dataView.setFloat32(byteOffset+32,this.scale.y,core.endian);
		dataView.setFloat32(byteOffset+36,this.scale.z,core.endian);

		dataView.setFloat32(byteOffset+40,this.velocity.x,core.endian);
		dataView.setFloat32(byteOffset+44,this.velocity.y,core.endian);
		dataView.setFloat32(byteOffset+48,this.velocity.z,core.endian);
		dataView.setFloat32(byteOffset+52,this.angularVelocity.x,core.endian);
		dataView.setFloat32(byteOffset+56,this.angularVelocity.y,core.endian);
		dataView.setFloat32(byteOffset+60,this.angularVelocity.z,core.endian);
		return byteOffset+64;
	}
	decodeOrientationPositionVelAngVelFromDataView( dataView, byteOffset) {
		this.orientation.x = dataView.getFloat32(byteOffset, core.endian);
		this.orientation.y = dataView.getFloat32(byteOffset+4, core.endian);
		this.orientation.z = dataView.getFloat32(byteOffset+8, core.endian);
		this.orientation.w = dataView.getFloat32(byteOffset+12, core.endian);
		this.position.x = dataView.getFloat32(byteOffset+16, core.endian);
		this.position.y = dataView.getFloat32(byteOffset+20, core.endian);
		this.position.z = dataView.getFloat32(byteOffset+24, core.endian);
		this.velocity.x = dataView.getFloat32(byteOffset+28, core.endian);
		this.velocity.y = dataView.getFloat32(byteOffset+32, core.endian);
		this.velocity.z = dataView.getFloat32(byteOffset+36, core.endian);
		this.angularVelocity.x = dataView.getFloat32(byteOffset+40, core.endian);
		this.angularVelocity.y = dataView.getFloat32(byteOffset+44, core.endian);
		this.angularVelocity.z = dataView.getFloat32(byteOffset+48, core.endian);
		return byteOffset+POSE_DYNAMIC_PACKED_SIZE;
	}
};

class NodePoseDynamic extends PoseDynamic
{
	constructor(){
		super();
		this.uid = BigInt(0);
	}
    static sizeof(){
        return PoseDynamic.sizeof()+8;
    }
    size(){
        return NodePoseDynamic.sizeof();
    }
	decodeFromDataView(dataView, byteOffset) {
		this.uid = dataView.getBigUint64(byteOffset, core.endian);
		this.decodeOrientationPositionVelAngVelFromDataView(dataView,byteOffset+8)
		return byteOffset+NODE_POSE_SIZE;
	}
}

class RenderState
{
    constructor(){
        this.lightmapScaleOffset= { x:1.0, y:1.0, z:0.0, w:0.0 };
		this.globalIlluminationUid=0;
    }
}

class Component {
    constructor()
	{
		//this.uid=0;
		this.data_uid=0;
	}
	getType(){
		return NodeDataType.Invalid;
	}
}

//! Listing a clip in the node payload makes the client treat it as a resource that must
//! arrive before the node can be completed, so the avatar does not appear until every clip
//! has been fetched. Animation is driven by ApplyAnimation commands referring to clips
//! streamed separately, so listing them buys nothing and costs the delay. Left false.
let sendAnimationUidsInNode = false;

function SetSendAnimationUidsInNode(enabled) {
	sendAnimationUidsInNode = !!enabled;
}

class MeshComponent extends Component
{
    constructor()
    {
		super();
		this.skeletonNodeID=0;
		this.renderState = new RenderState();
		this.meshUrl="";
		//! int16 indices into the skeleton's bone list, for a skinned mesh.
		this.joint_indices=[];
		//! Animation clip uids. Not sent unless SetSendAnimationUidsInNode(true); see above.
		this.animations=[];
		//! Material resource uids.
		this.materials=[];
    }
	getType() {
		return NodeDataType.Mesh;
	}
	encodedSize() {
		// type(1) data uid(8) skeletonNodeID(8) three uint16 counts(6) lightmapScaleOffset(16)
		// globalIlluminationUid(8)
		const animations=sendAnimationUidsInNode?(this.animations||[]):[];
		return 47 + (this.joint_indices||[]).length*2 + animations.length*8
			+ (this.materials||[]).length*8;
	}
	encodeIntoDataView(dataView,byteOffset) {
		byteOffset=core.put_uint8(dataView,byteOffset,NodeDataType.Mesh);

		var resuid=resources.GetOrAddResourceUidFromUrl(core.GeometryPayloadType.MeshPointer,this.meshUrl);
		byteOffset=core.put_uint64(dataView,byteOffset,resuid);

		byteOffset=core.put_uint64(dataView,byteOffset,this.skeletonNodeID);

		// Each of these three lists is written from its own contents. They were previously
		// hard-coded to zero with the loop below left in place, so setting one on a component
		// silently did nothing.
		const joint_indices=this.joint_indices||[];
		byteOffset=core.put_uint16(dataView,byteOffset,joint_indices.length);
		for (var i =0;i<joint_indices.length;i++)
		{
			byteOffset=core.put_int16(dataView,byteOffset,joint_indices[i]);
		}

		const animations=sendAnimationUidsInNode?(this.animations||[]):[];
		byteOffset=core.put_uint16(dataView,byteOffset,animations.length);
		for (var i =0;i<animations.length;i++)
		{
			byteOffset=core.put_uint64(dataView,byteOffset,animations[i]);
		}
		// If the node's priority is less than the *client's* minimum, we don't want
		// to send its mesh.

		const materials=this.materials||[];
		byteOffset=core.put_uint16(dataView,byteOffset,materials.length);
		for (var i =0;i<materials.length;i++)
		{
			byteOffset=core.put_uint64(dataView,byteOffset,materials[i]);
		}
		byteOffset=core.put_vec4(dataView,byteOffset,this.renderState.lightmapScaleOffset);
		byteOffset=core.put_uint64(dataView,byteOffset,this.renderState.globalIlluminationUid);
		
		return byteOffset;
	}
};
class TextCanvasComponent extends Component
{
    constructor()
    {
		super();
		this.canvasPath="";
    }
	getType() {
		return NodeDataType.TextCanvas;
	}
	encodeIntoDataView(dataView,byteOffset) {
		console.log("Encoding TextCanvasComponent: canvasPath=" + this.canvasPath + ", data_uid=" + this.data_uid);
		byteOffset=core.put_uint8(dataView,byteOffset,NodeDataType.TextCanvas);
		byteOffset=core.put_uint64(dataView,byteOffset,this.data_uid);
		return byteOffset;
	}
};

class SkeletonComponent extends Component
{
    constructor()
    {
		super();
    }
	getType(){
		return NodeDataType.Skeleton;
	}
};

// Server-side only. Sound components reference an audio asset on the server
// and are streamed via the WebRTC audio media track; they are never encoded
// into the scene-graph payload sent to clients.
class SoundComponent
{
	constructor(url = "")
	{
		this.url = url;
		this.loop = true;
		this.gain = 1.0;
	}
};

class Node {
	constructor( name = "") {
		this.uid = core.generateUid();
		this.name = name;
		this.pose = new Pose();
		this.parent_uid = 0;

		this.holder_client_id = 0;
		this.stationary = true;

		this.priority = 0;

		this.components = [];
		// Server-side only audio sources attached to this node. Not encoded
		// into the wire payload; consumed by SceneAudioStreamer.
		this.soundComponents = [];
	}
	static sizeof() {
		return 8 + 24 + Pose.size + 8;
	}
	size() {
		return Node.sizeof();
	}
	//! Buffer to allocate for encodeIntoDataView, including the 8-byte size prefix the
	//! encoder writes. Computed rather than guessed: a mesh component's joint, animation and
	//! material lists are variable-length, so a node with a skinned mesh can be far larger
	//! than a plain one.
	encodedSize() {
		// size prefix(8) type(1) uid(8) name(2+n) pose stationary(1) holder(8) priority(4)
		// parent(8) component count(1)
		let sz = 8 + 1 + 8 + 2 + Buffer.byteLength(this.name || "", 'utf8')
			+ Pose.size + 1 + 8 + 4 + 8 + 1;
		for (const c of this.components) {
			sz += (typeof c.encodedSize === 'function') ? c.encodedSize() : 256;
		}
		return sz;
	}
	setMeshComponent(mesh_url) {
		resources.GetOrAddMesh(mesh_url);
		this.components.forEach((component) => {
			if (component.getType() == NodeDataType.Mesh) {
				component.meshUrl = mesh_url;
				component.data_uid = resources.GetOrAddResourceUidFromUrl(
					core.GeometryPayloadType.MeshPointer,
					mesh_url
				);
				return;
			}
		});
		var m = new MeshComponent();
		m.meshUrl = mesh_url;
		m.data_uid = resources.GetOrAddResourceUidFromUrl(
			core.GeometryPayloadType.MeshPointer,
			mesh_url
		);
		this.components.push(m);
	}
	setSoundComponent(url) {
		for (const c of this.soundComponents) {
			if (c.url === url) return;
		}
		this.soundComponents.push(new SoundComponent(url));
	}
	setCanvasComponent(canvas_path) {
		this.components.forEach((component) => {
			if (component.getType() == NodeDataType.TextCanvas) {
				component.canvasPath = canvas_path;
				component.data_uid = resources.GetResourceUidFromUrl(
					core.GeometryPayloadType.TextCanvas,
					canvas_path
				);
				return;
			}
		});
		var tc = new TextCanvasComponent();
		tc.canvasPath = canvas_path;
		tc.data_uid = resources.GetResourceUidFromUrl(
			core.GeometryPayloadType.TextCanvas,
			canvas_path
		);
		this.components.push(tc);
	}
	encodeIntoDataView(dataView, byteOffset, fromAxes, toAxes) {
		byteOffset = core.put_uint8(
			dataView,
			byteOffset,
			core.GeometryPayloadType.Node
		);

		byteOffset = core.put_uint64(dataView, byteOffset, this.uid);
		byteOffset = core.put_string(dataView, byteOffset, this.name);
		// Convert the node's transform into the client's axes standard (server -> client). When no
		// conversion is requested, or the standards match, the pose is encoded unchanged.
		var clientsidePose = this.pose;
		if (fromAxes !== undefined && toAxes !== undefined && fromAxes !== toAxes &&
			toAxes !== core.AxesStandard.NotInitialized)
		{
			const c = core.ConvertPose(fromAxes, toAxes, this.pose);
			clientsidePose = new Pose();
			clientsidePose.position = c.position;
			clientsidePose.orientation = c.orientation;
			clientsidePose.scale = c.scale;
		}

		byteOffset = clientsidePose.encodeIntoDataView(dataView, byteOffset);
		
		byteOffset = core.put_uint8(dataView, byteOffset, this.stationary);
		byteOffset = core.put_uint64(
			dataView,
			byteOffset,
			this.holder_client_id
		);
		byteOffset = core.put_int32(dataView, byteOffset, this.priority);
		byteOffset = core.put_uint64(dataView, byteOffset, this.parent_uid);

		// Data components. Let's say 8 bits for number of components.
		byteOffset = core.put_uint8(
			dataView,
			byteOffset,
			this.components.length
		);
		for (var i = 0; i < this.components.length; i++) {
			if (this.components[i].getType() == NodeDataType.TextCanvas) {
				console.log("Encoding node '" + this.name + "' (uid=" + this.uid + ") TextCanvas component[" + i + "]");
			}
			byteOffset = this.components[i].encodeIntoDataView(
				dataView,
				byteOffset
			);
		}

		return byteOffset;
		/*
		if (this.data_type ==NodeDataType.Light)
		{
			put(this.lightColour);
			put(this.lightRadius);
			put(this.lightRange);
			vec3 lightDirection = this.lightDirection;
			avs::ConvertPosition(serverSettings.serverAxesStandard, geometryStreamingService.getClientAxesStandard(), lightDirection);
			put(lightDirection);
			put(this.lightType);
		}
		if (this.data_type == avs::NodeDataType::TextCanvas)
		{
			// nothing this-specific to add at present.
		}
		if (this.data_type == avs::NodeDataType::Skeleton)
		{
		}
		if (this.data_type == avs::NodeDataType::Link)
		{
			size_t urlLength = this.url.length();
			put(urlLength);
			put((uint8_t *)this.url.data(), urlLength);
			size_t queryLength = this.query_url.length();
			put(queryLength);
			put((uint8_t *)this.query_url.data(), queryLength);

		}*/
	}
};

module.exports = {NodeDataType,Pose,PoseDynamic,NodePoseDynamic, Node, SoundComponent,
	MeshComponent, SetSendAnimationUidsInNode,
	POSE_PACKED_SIZE, POSE_DYNAMIC_PACKED_SIZE, NODE_POSE_SIZE };
