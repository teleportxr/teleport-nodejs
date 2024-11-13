'use strict';
class Pose
{
    constructor()
    {
		this.orientation = { x:0, y:0, z:0, s:1 };
		this.position = { x:0, y:0, z:0 };
	}
};
class PoseDynamic
{
	constructor(){
		this.pose=new Pose();
		this.velocity={x:0,y:0,z:0};
		this.angularVelocity={x:0,y:0,z:0};
	}
};

class Node
{
    constructor(uid)
    {
		this.uid=uid;
		this.name= "";
		this.pose=new Pose();
		this.uid=0;
		this.parent_uid=0;
    }
};

module.exports = {Pose,PoseDynamic, Node };
