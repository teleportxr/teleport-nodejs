'use strict';
// using https://github.com/infusion/BitSet.js
const bit=require("bitset.js");

class TrackedResource
{
    constructor(){
        this.clientNeeds=new BitSet();		    // whether we THINK the client NEEDS the resource.
        this.sent=new BitSet();			        // Whether we have actually sent the resource,
        this.sent_server_time_us=BigInt(0); // and when we sent it.
        this.acknowledged=new BitSet();	        // Whether the client acknowledged receiving the resource.
    }
};
class GeometryService
{
    constructor(){
    }
};

module.exports= {GeometryService};
