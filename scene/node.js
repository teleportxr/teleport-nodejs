'use strict';
class Pose
{
    constructor()
    {
		this.orientation = { x:0.0, y:0.0, z:0.0, s:1.0 };
		this.position = { x:0.0, y:0.0, z:0.0 };
	}
    static sizeof(){
        return 4*4+(3*4);
    }
    size(){
        return Pose.sizeof();
    }
	encodeIntoDataView(dataView,byteOffset) {
		var byteOffset=0;
		dataView.setFloat32(0,this.orientation.x);
		dataView.setFloat32(4,this.orientation.y);
		dataView.setFloat32(8,this.orientation.z);
		dataView.setFloat32(12,this.orientation.w);
		dataView.setFloat32(16,this.position.x);
		dataView.setFloat32(20,this.position.y);
		dataView.setFloat32(24,this.position.z);
		return byteOffset;
	}
	encodeToUint8Array(){
		var array=new Uint8Array(this.size());
		var dataView=new DataView(array.buffer);
		this.encodeIntoDataView(dataView);
		return array;
	}
};
class PoseDynamic
{
	constructor(){
		this.pose=new Pose();
		this.velocity={x:0.0, y:0.0, z:0.0 };
		this.angularVelocity={x:0.0, y:0.0, z:0.0 };
	}
    static sizeof(){
        return 4*4+(3*4)+(3*4)+(3*4);
    }
    size(){
        return PoseDynamic.sizeof();
    }
	encodeIntoDataView(dataView,byteOffset) {
		var byteOffset=0;
		dataView.setFloat32(0,this.orientation.x);
		dataView.setFloat32(4,this.orientation.y);
		dataView.setFloat32(8,this.orientation.z);
		dataView.setFloat32(12,this.orientation.w);
		dataView.setFloat32(16,this.position.x);
		dataView.setFloat32(20,this.position.y);
		dataView.setFloat32(24,this.position.z);
		dataView.setFloat32(28,this.velocity.x);
		dataView.setFloat32(32,this.velocity.y);
		dataView.setFloat32(36,this.velocity.z);
		dataView.setFloat32(40,this.angularVelocity.x);
		dataView.setFloat32(44,this.angularVelocity.y);
		dataView.setFloat32(48,this.angularVelocity.z);
		return byteOffset;
	}
};

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
	Link:7
};
class RenderState
{
    constructor(){
        this.lightmapScaleOffset= { x:1.0, y:1.0, z:0.0, w:0.0 };
		this.globalIlluminationUid=0;
    }
}

class Node
{
    constructor(uid)
    {
		this.uid=uid;
		this.name= "";
		this.pose=new Pose();
		this.parent_uid=0;
		this.data_type=NodeDataType.None;

		this.holder_client_id=0;
		this.stationary=true;

		this.priority=0;
		this.data_uid=0;

		this.skeletonNodeID=0;

		this.renderState=new RenderState();
    }
    static sizeof(){
        return 8+24+Pose.size+8;
    }
    size(){
        return Node.sizeof();
    }
	encodeToUint8Array(){
		var array=new Uint8Array(this.size());
		var dataView=new DataView(array.buffer);
		var byteOffset=0;
		dataView.setBigUint64(byteOffset,this.uid);		byteOffset+=8;
		dataView.setBigUint64(byteOffset,24);			byteOffset+=8;
		dataView.setUint8(byteOffset,0);				byteOffset+=24;
		dataView.setFloat32(8,this.orientation.z);
		dataView.setFloat32(12,this.orientation.w);
		dataView.setFloat32(16,this.position.x);
		dataView.setFloat32(20,this.position.y);
		dataView.setFloat32(24,this.position.z);
		dataView.setFloat32(28,this.velocity.x);
		dataView.setFloat32(32,this.velocity.y);
		dataView.setFloat32(36,this.velocity.z);
		dataView.setFloat32(40,this.angularVelocity.x);
		dataView.setFloat32(44,this.angularVelocity.y);
		dataView.setFloat32(48,this.angularVelocity.z);
		return array;
	}
};

module.exports = {NodeDataType,Pose,PoseDynamic,Node };
