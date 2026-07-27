const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'fitness',
  },
});

const WEEKLY_WORKOUT_GOAL = 4;
const PORT = Number(process.env.PORT || 4000);

const app = express();

app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true,
  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],
  allowedHeaders: [
    'Content-Type',
    'x-api-key',
    'Authorization',
    'Cookie'
  ],
}));

app.use(express.json());


// ===============================
// SIMPLE SESSION SYSTEM
// ===============================

const SESSION_COOKIE_NAME = 'g_fitness_sid';
const DEFAULT_SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

const sessionStore = new Map();


function parseCookies(cookieHeader) {
  const cookies = {};

  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach(pair => {
    const index = pair.indexOf('=');

    if (index < 0) return;

    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}


function serializeCookie(name, value, options = {}) {

  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax'
  ];


  if (options.clear) {
    parts.push(
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    );
  }
  else if (options.maxAgeMs) {
    parts.push(
      `Expires=${new Date(
        Date.now() + options.maxAgeMs
      ).toUTCString()}`
    );
  }


  return parts.join('; ');
}



function sessionMiddleware(req,res,next){

  const cookies = parseCookies(
    req.headers.cookie
  );


  let sid = cookies[SESSION_COOKIE_NAME];

  let record = sid
    ? sessionStore.get(sid)
    : undefined;


  if(record && record.expiresAt < Date.now()){

    sessionStore.delete(sid);

    record = undefined;
    sid = undefined;
  }


  if(!record){

    record = {
      authUserId:null,
      activeProfileUserId:null,
      expiresAt:
        Date.now()+DEFAULT_SESSION_MAX_AGE
    };

  }



  const sessionApi = {


    cookie:{
      maxAge:DEFAULT_SESSION_MAX_AGE
    },


    get authUserId(){
      return record.authUserId;
    },


    set authUserId(value){
      record.authUserId=value;
    },


    get activeProfileUserId(){
      return record.activeProfileUserId;
    },


    set activeProfileUserId(value){
      record.activeProfileUserId=value;
    },



    regenerate(callback){

      if(sid){
        sessionStore.delete(sid);
      }


      sid = crypto
        .randomBytes(24)
        .toString('hex');


      record={
        authUserId:null,
        activeProfileUserId:null,
        expiresAt:
          Date.now()+DEFAULT_SESSION_MAX_AGE
      };


      sessionStore.set(
        sid,
        record
      );


      callback(null);

    },



    save(callback){

      if(!sid){

        sid=crypto
          .randomBytes(24)
          .toString('hex');

      }


      record.expiresAt =
        Date.now()+sessionApi.cookie.maxAge;


      sessionStore.set(
        sid,
        record
      );


      res.setHeader(
        'Set-Cookie',
        serializeCookie(
          SESSION_COOKIE_NAME,
          sid,
          {
            maxAgeMs:
            sessionApi.cookie.maxAge
          }
        )
      );


      callback(null);

    },



    destroy(callback){

      if(sid){
        sessionStore.delete(sid);
      }


      res.setHeader(
        'Set-Cookie',
        serializeCookie(
          SESSION_COOKIE_NAME,
          '',
          {
            clear:true
          }
        )
      );


      callback(null);

    }

  };


  req.session=sessionApi;

  next();
}


app.use(sessionMiddleware);



setInterval(()=>{

  const now=Date.now();

  for(const [sid,session] of sessionStore){

    if(session.expiresAt < now){

      sessionStore.delete(sid);

    }

  }

},1000*60*10).unref();




// ===============================
// API KEY
// ===============================

const SAFE_API_KEY =
"kP9x!V4mQz7@L2sT8#nR6wY1uH5dJ0bC#";


function requireApiKey(req,res,next){

  if(
    req.method==="OPTIONS" ||
    (
      req.method==="POST" &&
      req.path==="/auth/login"
    )
  ){
    return next();
  }


  const apiKey=req.get(
    'x-api-key'
  );


  if(!apiKey || apiKey!==SAFE_API_KEY){

    return res.status(401).json({
      success:false,
      message:"Invalid API key."
    });

  }


  next();

}



function requireSessionAuth(req,res,next){

  if(req.session?.authUserId){

    return next();

  }


  return res.status(401).json({
    success:false,
    message:"Authentication required."
  });

}



function asyncHandler(fn){

  return (req,res,next)=>
    Promise
      .resolve(fn(req,res,next))
      .catch(next);

}



// IMPORTANT:
// All /api routes require API key
app.use('/api',requireApiKey);




// ===============================
// DATE HELPERS
// ===============================

function toDateKey(date){

  const y=date.getFullYear();

  const m=String(
    date.getMonth()+1
  ).padStart(2,'0');


  const d=String(
    date.getDate()
  ).padStart(2,'0');


  return `${y}-${m}-${d}`;
}


function fromDateKey(dateKey){

  const [
    y,
    m,
    d
  ] = dateKey.split('-')
    .map(Number);


  return new Date(
    y,
    m-1,
    d
  );

}



function getWeekStart(date){

  const start=new Date(date);

  start.setHours(
    0,0,0,0
  );


  const day=start.getDay();

  const shift =
    day===0
      ? -6
      : 1-day;


  start.setDate(
    start.getDate()+shift
  );


  return start;

}



function getWeekEnd(date){

  const end=getWeekStart(date);

  end.setDate(
    end.getDate()+6
  );


  return end;

}
// ===============================
// WEEK HELPERS
// ===============================


function getWeekDates(weekStartKey){

  const weekStart = fromDateKey(
    weekStartKey
  );


  return Array.from(
    {length:7},
    (_,i)=>{

      const next = new Date(
        weekStart
      );

      next.setDate(
        weekStart.getDate()+i
      );


      return toDateKey(next);

    }
  );

}




// ===============================
// DATABASE HELPERS
// ===============================


async function getProfileUserById(userId){

  if(!userId) return null;


  return knex('app_users')
    .where({
      id:userId,
      is_active:1
    })
    .first();

}




// ===============================
// FIXED ENSURE CURRENT WEEK
// ===============================

async function ensureCurrentWeek(
  userId,
  referenceDate = new Date()
){


  if(!userId){

    throw new Error(
      "ensureCurrentWeek failed: userId is missing"
    );

  }



  const weekStart =
    toDateKey(
      getWeekStart(referenceDate)
    );


  const weekEnd =
    toDateKey(
      getWeekEnd(referenceDate)
    );



  let week =
    await knex('tracker_weeks')
      .where({
        user_id:userId,
        week_start:weekStart
      })
      .first();



  if(week){


    if(
      week.status !== "current"
    ){

      await knex('tracker_weeks')
        .where({
          id:week.id
        })
        .update({

          status:"current",

          archived_at:null,

          week_end:weekEnd

        });


      week.status="current";
      week.archived_at=null;
      week.week_end=weekEnd;

    }



    return week;

  }




  await knex('tracker_weeks')
    .where({
      user_id:userId,
      status:"current"
    })
    .update({

      status:"archived",

      archived_at:
        knex.fn.now()

    });



  const [id] =
    await knex('tracker_weeks')
      .insert({

        user_id:userId,

        week_start:weekStart,

        week_end:weekEnd,

        status:"current"

      });



  return knex('tracker_weeks')
    .where({
      id
    })
    .first();


}





// ===============================
// LOAD WEEK
// ===============================


async function loadWeekWithDays(
  week
){

  const dateKeys =
    getWeekDates(
      week.week_start
    );



  const days =
    await knex('tracker_days')
      .where({
        week_id:week.id
      });



  const dayMap =
    new Map(
      days.map(
        d=>[
          d.date_key,
          d
        ]
      )
    );



  const dayIds =
    days.map(
      d=>d.id
    );



  const links =
    dayIds.length
      ?
      await knex('tracker_day_activities')
        .whereIn(
          'day_id',
          dayIds
        )
      :
      [];



  const activityMap =
    new Map();



  for(const link of links){

    if(!activityMap.has(link.day_id)){

      activityMap.set(
        link.day_id,
        []
      );

    }


    activityMap
      .get(link.day_id)
      .push(
        link.activity_id
      );

  }




  const result={

    weekStart:
      week.week_start,


    weekEnd:
      week.week_end,


    status:
      week.status,


    days:{}

  };





  for(
    const dateKey of dateKeys
  ){

    const day =
      dayMap.get(
        dateKey
      );


    result.days[dateKey]={

      date:dateKey,


      activityIds:
        day
          ?
          activityMap.get(day.id) || []
          :
          []

    };

  }



  return result;

}





// ===============================
// FIXED TRACKER STATE
// ===============================


async function assembleTrackerState(
  activeUserId
){


  const users =
    await knex('app_users')
      .where({
        is_active:1
      })
      .orderBy(
        'sort_order'
      );



  if(users.length===0){

    return {

      version:1,

      activeUserId:null,

      users:{}

    };

  }




  const activeId =
    activeUserId || users[0].id;



  const activeUserExists =
    users.some(
      u=>u.id===activeId
    );



  const state={

    version:1,

    activeUserId:
      activeUserExists
        ?
        activeId
        :
        users[0].id,


    users:{}

  };





  for(
    const user of users
  ){


    const currentWeekRow =
      await ensureCurrentWeek(
        user.id
      );



    const currentWeek =
      await loadWeekWithDays(
        currentWeekRow
      );



    const otherWeeks =
      await knex('tracker_weeks')
        .where({
          user_id:user.id
        })
        .andWhereNot({
          id:currentWeekRow.id
        })
        .orderBy(
          'week_start',
          'desc'
        );



    const history=[];



    for(
      const week of otherWeeks
    ){

      history.push(
        await loadWeekWithDays(
          week
        )
      );

    }



    state.users[user.id]={

      id:user.id,

      name:user.name,

      accent:user.accent,

      ring:user.ring,

      currentWeek,

      history

    };

  }



  return state;

}





// ===============================
// WEIGHT FUNCTIONS
// ===============================


function mapWeightRow(row){

  if(!row) return null;


  return {

    id:row.id,

    userId:row.user_id,

    weekStart:row.week_start,

    weightValue:
      Number(row.weight_value),


    unit:row.unit,

    notes:row.notes,

    measuredAt:row.measured_at,

    createdAt:row.created_at,

    updatedAt:row.updated_at

  };

}