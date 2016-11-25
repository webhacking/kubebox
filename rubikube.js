process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

var blessed  = require('blessed'),
    contrib  = require('blessed-contrib'),
    moment   = require('moment'),
    duration = require('moment-duration-format'),
    screen   = blessed.screen();

var session = {
  access_token: null,
  namespace   : 'default',
  pods        : {}
};

// https://docs.openshift.org/latest/architecture/additional_concepts/authentication.html
// https://github.com/openshift/openshift-docs/issues/707
var authorize = {
  hostname: '192.168.64.3',
  protocol: 'https:',
  port    : 8443,
  path    : '/oauth/authorize?client_id=openshift-challenging-client&response_type=token',
  method  : 'GET',
  auth    : 'admin:admin'
};

var get_namespaces = token => ({
  hostname: '192.168.64.3',
  protocol: 'https:',
  port    : 8443,
  path    : '/api/v1/namespaces',
  method  : 'GET',
  headers : {
    'Authorization': `Bearer ${token}`,
    'Accept'       : 'application/json, text/plain, */*'
  }
});

var get_pods = (namespace, token) => ({
  hostname: '192.168.64.3',
  protocol: 'https:',
  port    : 8443,
  path    : `/api/v1/namespaces/${namespace}/pods`,
  method  : 'GET',
  headers : {
    'Authorization': `Bearer ${token}`,
    'Accept'       : 'application/json, text/plain, */*'
  }
});

var watch_pods = (namespace, token, resourceVersion) => ({
  hostname: '192.168.64.3',
  protocol: 'https:',
  port    : 8443,
  path    : `/api/v1/namespaces/${namespace}/pods?watch=true&resourceVersion=${resourceVersion}&access_token=${token}`,
  method  : 'GET',
  headers : {
    'Authorization': `Bearer ${token}`,
    'Accept'       : 'application/json, text/plain, */*'
  }
});

var grid = new contrib.grid({rows: 12, cols: 12, screen: screen});

var table = grid.set(0, 0, 6, 6, contrib.table, {
  keys         : true,
  fg           : 'white',
  selectedFg   : 'white',
  selectedBg   : 'blue',
  interactive  : true,
  label        : 'Pods',
  width        : '50%',
  height       : '30%',
  border       : {type: 'line', fg: 'cyan'},
  columnSpacing: 3,
  columnWidth  : [32, 9, 15]
});

var debug = grid.set(0, 0, 12, 12, contrib.log, {
  fg        : 'green',
  selectedFg: 'green',
  label     : 'Logs'
});

// TODO: display a list table with some high level info about the namespaces
var list = blessed.list({
  top   : 'center',
  left  : 'center',
  width : '50%',
  height: '50%',
  label : 'Namespaces',
  keys  : true,
  tags  : true,
  border: {type: 'line'},
  style : {
    fg      : 'white',
    border  : {fg: '#ffffff'},
    selected: {bg: 'blue'}
  }
});
list.on('cancel', () => {
  list.detach();
  screen.render();
});
list.on('select', item => {
  session.namespace = item.content;
  list.detach();
  screen.render();
  debug.log(`Switching to namespace ${session.namespace}`);
  // FIXME: cancel the promises / requests (watch) from the previous dashboard
  dashboard().catch(console.error);
});

screen.key(['n'], () => {
  screen.append(list);
  list.focus();
  screen.render();
  // TODO: watch for namespace changes when the selection list is open
  get(get_namespaces(session.access_token))
    .then(response => JSON.parse(response.body.toString('utf8')))
    .then(namespaces => list.setItems(namespaces.items.reduce((data, namespace) => {
      data.push(namespace.metadata.name);
      return data;
    }, [])))
    .then(() => screen.render())
    .catch(console.error);
});

screen.key(['q', 'C-c'], (ch, key) => process.exit(0));

var carousel = new contrib.carousel([screen => {
  screen.append(table);
  table.focus();
}, screen => screen.append(debug)], {
  screen     : screen,
  interval   : 0,
  controlKeys: true
});
carousel.start();

get(authorize)
  .then(response => response.headers.location.match(/access_token=([^&]+)/)[1])
  .then(token => session.access_token = token)
  .then(dashboard)
  .catch(console.error);

function dashboard() {
  return get(get_pods(session.namespace, session.access_token))
    .then(response => JSON.parse(response.body.toString('utf8')))
    .then(pods => {
      table.setData({
        headers: ['NAME', 'STATUS', 'AGE'],
        data   : pods.items.reduce((data, pod) => {
          data.push([
            pod.metadata.name,
            pod.status.phase,
            moment.duration(moment().diff(moment(pod.status.startTime))).format()
          ]);
          return data;
        }, [])
      });
      session.pods.resourceVersion = pods.metadata.resourceVersion;
    })
    .then(() => screen.render())
    .then(() => debug.log(`Watching for pods changes in namespace ${session.namespace} ...`))
    .then(() => get(watch_pods(session.namespace, session.access_token, session.pods.resourceVersion),
      function*() {
        while (true)
          debug.log((yield).toString('utf8'));
        // TODO: update the pods table
      }));
}

function get(options, generator, async = true) {
  return generator ? getStream(options, generator, async) : getBody(options);
}

function getBody(options) {
  return new Promise((resolve, reject) => {
    const client = (options.protocol || 'http').startsWith('https') ? require('https') : require('http');
    client.get(options, response => {
      if (response.statusCode >= 400) {
        reject(new Error(`Failed to get resource, status code: ${response.statusCode}`));
        // FIXME: should the request be aborted to avoid to resolve the rejected promise on end
      }
      const body = [];
      response.on('data', chunk => body.push(chunk))
        .on('end', () => {
          response.body = Buffer.concat(body);
          resolve(response);
        });
    }).on('error', reject);
  })
}

// TODO: throw / return the generator if the request is aborted / closed
function getStream(options, generator, async = true) {
  return new Promise((resolve, reject) => {
    const client = (options.protocol || 'http').startsWith('https') ? require('https') : require('http');
    client.get(options, response => {
      if (response.statusCode >= 400) {
        reject(new Error(`Failed to get resource, status code: ${response.statusCode}`));
        // FIXME: should the request be aborted to avoid to resolve the rejected promise on end
      }
      const gen = generator();
      gen.next();
      response.on('data', chunk => {
        const res = gen.next(chunk);
        if (res.done) {
          // we may work on the http.ClientRequest if needed
          response.destroy();
          response.body = res.value;
          // ignored for async as it's already been resolved
          resolve(response);
        }
      });
      if (async) {
        resolve(response);
        response.on('end', () => {
          // ignored if the generator is done already
          gen.return();
        });
      } else {
        response.on('end', () => {
          const res = gen.next();
          if (!res.done) {
            response.body = res.value;
            resolve(response);
          }
        });
      }
    }).on('error', reject);
  })
}