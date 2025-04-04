'use strict';
const core= require('../core/core.js');
const resources= require('./resources.js');

const MaterialMode =
{
	UNKNOWNMODE:0,
	OPAQUE_MATERIAL:1,
	TRANSPARENT_MATERIAL:2
};

class MaterialTexture
{
	constructor(uid=0,texCoord=0,tile_x=1.0,tile_y=1.0)
	{
		this.textureUid = uid;
		this.texCoord = texCoord;
		this.tiling = {x:tile_x, y:tile_y};
	}
	encodeIntoDataView(dataView,byteOffset) {
		byteOffset=core.put_uint64(dataView,byteOffset,this.textureUid);
		byteOffset=core.put_uint8(dataView,byteOffset,this.texCoord);
		byteOffset=core.put_float32(dataView,byteOffset,this.tiling.x);
		byteOffset=core.put_float32(dataView,byteOffset,this.tiling.y);
		return byteOffset;
	}
};

class Material
{
	constructor(uid,name="")
	{
		this.uid=uid;
		this.name=name;

		this.materialMode = MaterialMode.OPAQUE_MATERIAL;
		this.baseColorTexture=new MaterialTexture();
		this.baseColorFactor = {x:1.0, y:1.0, z: 1.0, w: 1.0};
		this.metallicRoughnessTexture=new MaterialTexture();
		this.metallicFactor = 0.0;
		this.roughnessMultiplier = 1.0;
		this.roughnessOffset = 0.0;

		this.normalTexture=new MaterialTexture();
		this.normalTexture.scale = NextFloat;

		this.occlusionTexture=new MaterialTexture();

		this.emissiveTexture=new MaterialTexture();
		this.emissiveFactor={x: 0.0, y: 0.0, z:0.0};

		this.doubleSided = false;
		this.lightmapTexCoordIndex = 0;

		this.extensions = [];
	}
	encodeIntoDataView(dataView,byteOffset) {
		
		byteOffset=core.put_uint8(dataView,byteOffset,core.GeometryPayloadType.Material);
		byteOffset=core.put_uint64(dataView,byteOffset,this.uid);
		byteOffset=core.put_string(dataView,byteOffset,this.name);

		byteOffset=core.put_uint8(dataView,byteOffset,this.materialMode);

		byteOffset=this.baseColorTexture.encodeIntoDataView(dataView,byteOffset);
		byteOffset=core.put_vec4(dataView,byteOffset,this.baseColorFactor);

		byteOffset=this.metallicRoughnessTexture.encodeIntoDataView(dataView,byteOffset);

		byteOffset=core.put_float32(dataView,byteOffset,this.metallicFactor);
		byteOffset=core.put_float32(dataView,byteOffset,this.roughnessMultiplier);
		byteOffset=core.put_float32(dataView,byteOffset,this.roughnessOffset);
		
		byteOffset=this.normalTexture.encodeIntoDataView(dataView,byteOffset);
		// TODO make this depend on (renderingFeatures.normals)
	
		byteOffset=core.put_float32(dataView,byteOffset,1.0);


		byteOffset=this.occlusionTexture.encodeIntoDataView(dataView,byteOffset);

		byteOffset=core.put_float32(dataView,byteOffset,1.0);

		byteOffset=this.emissiveTexture.encodeIntoDataView(dataView,byteOffset);

		byteOffset=core.put_vec3(dataView,byteOffset,this.emissiveFactor);

		byteOffset=core.put_uint8(dataView,byteOffset,this.doubleSided);
		byteOffset=core.put_uint8(dataView,byteOffset,this.lightmapTexCoordIndex);

		byteOffset=core.put_uint64(dataView,byteOffset,BigInt(0));
	}
	encodeToUint8Array(){
		var array=new Uint8Array(this.size());
		var dataView=new DataView(array.buffer);
		this.encodeIntoDataView(dataView);
		return array;
	}
	/*static sizeof() {
		return 8+24+Pose.size+8;
	}
	size() {
		return Node.sizeof();
	}*/
};