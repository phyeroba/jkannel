import React from 'react';
import { AppShell } from './AppShell.jsx';
import { CARRIERS, SERVICES, SMSCS } from './estate.jsx';
import { LoginScreen } from './LoginScreen.jsx';
import { DashboardScreen } from './DashboardScreen.jsx';
import { AlertsScreen } from './AlertsScreen.jsx';
import { CarriersScreen } from './CarriersScreen.jsx';
import { CarrierDetailScreen } from './CarrierDetailScreen.jsx';
import { SmscsScreen } from './SmscsScreen.jsx';
import { SmscDetailScreen } from './SmscDetailScreen.jsx';
import { SessionsScreen } from './SessionsScreen.jsx';
import { TrafficScreen } from './TrafficScreen.jsx';
import { QueuesScreen } from './QueuesScreen.jsx';
import { DlrScreen } from './DlrScreen.jsx';
import { RoutesScreen } from './RoutesScreen.jsx';
import { FailoverScreen } from './FailoverScreen.jsx';
import { SimulatorScreen } from './SimulatorScreen.jsx';
import { TraceScreen } from './TraceScreen.jsx';
import { SmppErrorsScreen } from './SmppErrorsScreen.jsx';
import { EventsScreen } from './EventsScreen.jsx';
import { LogsScreen } from './LogsScreen.jsx';
import { ToolsScreen } from './ToolsScreen.jsx';
import { EngineConfigScreen } from './EngineConfigScreen.jsx';
import { ServicesScreen } from './ServicesScreen.jsx';
import { ServiceDetailScreen } from './ServiceDetailScreen.jsx';
import { NodesScreen } from './NodesScreen.jsx';
import { PerformanceScreen } from './PerformanceScreen.jsx';
import { AuditScreen } from './AuditScreen.jsx';
import { UsersScreen } from './UsersScreen.jsx';

/* Route table mirrors section 2's information architecture. "analytical" marks the
   screens that honour the global time range; "freshness" lets a screen report
   degraded telemetry in the shell rather than silently. */
const PAGES = {
  '/dashboard': { title: 'Dashboard', subtitle: 'Whether the gateway and carrier estate are healthy, where impact exists, and what needs attention first.', crumbs: ['Overview', 'Dashboard'], analytical: true, render: (p) => <DashboardScreen {...p} /> },
  '/alerts': { title: 'Alerts', subtitle: 'Active operational risk, grouped into incidents with their impact and evidence.', crumbs: ['Overview', 'Alerts'], render: (p) => <AlertsScreen {...p} /> },

  '/carriers': { title: 'Carriers', subtitle: 'The carrier register. Open a network for its health, traffic, SMSCs and incidents.', crumbs: ['Connectivity', 'Carriers'], render: (p) => <CarriersScreen {...p} /> },
  '/smscs': { title: 'SMSCs', subtitle: 'Carrier connections across every market, and the controlled actions available on each.', crumbs: ['Connectivity', 'SMSCs'], render: (p) => <SmscsScreen {...p} /> },
  '/sessions': { title: 'SMPP Sessions', subtitle: 'Bind state, keepalive health, protocol counters and flapping history.', crumbs: ['Connectivity', 'SMPP Sessions'], analytical: true, render: (p) => <SessionsScreen {...p} /> },

  '/traffic': { title: 'Live Traffic', subtitle: 'Real-time MT, MO and DLR flow with capacity and queue beside it.', crumbs: ['Traffic', 'Live Traffic'], analytical: true, render: (p) => <TrafficScreen {...p} /> },
  '/queues': { title: 'Queues', subtitle: 'Depth, age and growth per destination — with the cause named and drain honestly estimated.', crumbs: ['Traffic', 'Queues'], render: (p) => <QueuesScreen {...p} /> },
  '/dlr': { title: 'DLR Performance', subtitle: 'Delivery funnel, status breakdown and carrier quality over identical windows.', crumbs: ['Traffic', 'DLR Performance'], analytical: true, render: (p) => <DlrScreen {...p} /> },

  '/routes': { title: 'Carrier Routes', subtitle: 'Network-level routing, target order and continuity if the active path fails.', crumbs: ['Routing', 'Carrier Routes'], render: (p) => <RoutesScreen {...p} /> },
  '/failover': { title: 'Failover', subtitle: 'Move a route to another connection, with health, capacity and queue implications stated first.', crumbs: ['Routing', 'Failover'], render: (p) => <FailoverScreen {...p} /> },
  '/simulator': { title: 'Route Simulator', subtitle: 'Resolve where a destination would be sent. Non-transmitting.', crumbs: ['Routing', 'Route Simulator'], render: (p) => <SimulatorScreen {...p} /> },

  '/trace': { title: 'Message Trace', subtitle: 'One message end to end, with the first abnormal or missing stage called out.', crumbs: ['Diagnostics', 'Message Trace'], render: (p) => <TraceScreen {...p} /> },
  '/smpp-errors': { title: 'SMPP Errors', subtitle: 'Command statuses decoded, counted and correlated with traffic and queues.', crumbs: ['Diagnostics', 'SMPP Errors'], analytical: true, render: (p) => <SmppErrorsScreen {...p} /> },
  '/events': { title: 'Events', subtitle: 'The structured event stream every other screen links into.', crumbs: ['Diagnostics', 'Events'], analytical: true, render: (p) => <EventsScreen {...p} /> },
  '/logs': { title: 'Logs', subtitle: 'Live tail with a context window around any correlation ID.', crumbs: ['Diagnostics', 'Logs'], render: (p) => <LogsScreen {...p} /> },
  '/tools': { title: 'Test Tools', subtitle: 'Connectivity test, controlled test send, DLR lookup, encoding and number analysis.', crumbs: ['Diagnostics', 'Test Tools'], render: (p) => <ToolsScreen {...p} /> },
  '/engine-config': { title: 'Engine Configuration', subtitle: 'Engineering diagnostics: the file the gateway generated, and who owns each directive.', crumbs: ['Diagnostics', 'Engine Configuration'], render: (p) => <EngineConfigScreen {...p} /> },

  '/services': { title: 'Services', subtitle: 'The component register. Open a service for its dependencies and controls.', crumbs: ['System', 'Services'], render: (p) => <ServicesScreen {...p} /> },
  '/nodes': { title: 'Nodes', subtitle: 'Hosts running gateway components and the resource pressure that matters.', crumbs: ['System', 'Nodes'], render: (p) => <NodesScreen {...p} /> },
  '/performance': { title: 'Performance', subtitle: 'Gateway-side latency and capacity headroom, with the sampling interval stated.', crumbs: ['System', 'Performance'], analytical: true, render: (p) => <PerformanceScreen {...p} /> },
  '/audit': { title: 'Audit Trail', subtitle: 'Every privileged action with its actor, previous state, reason and result.', crumbs: ['System', 'Audit Trail'], analytical: true, render: (p) => <AuditScreen {...p} /> },
  '/users': { title: 'Users & Roles', subtitle: 'Operational access: the five personas and what each may do.', crumbs: ['System', 'Users & Roles'], render: (p) => <UsersScreen {...p} /> },
};

/* A carrier has its own page at /carriers/<id>: the register can grow to dozens
   of networks, so detail must not live underneath the list. */
function resolve(route) {
  if (route.startsWith('/carriers/')) {
    const id = route.slice('/carriers/'.length);
    const carrier = CARRIERS.find((c) => c.id === id);
    return {
      title: carrier ? carrier.name : 'Carrier',
      subtitle: carrier
        ? carrier.country + ' · network ' + carrier.mcc + '-' + carrier.mnc + ' · prefixes ' + carrier.prefixes
        : 'This carrier is not in the register.',
      crumbs: ['Connectivity', { label: 'Carriers', to: '/carriers' }, carrier ? carrier.name : id],
      analytical: true,
      render: (p) => <CarrierDetailScreen carrierId={id} {...p} />,
    };
  }
  if (route.startsWith('/smscs/')) {
    const id = route.slice('/smscs/'.length);
    const smsc = SMSCS.find((s) => s.id === id);
    return {
      title: smsc ? smsc.id : 'SMSC',
      subtitle: smsc
        ? smsc.carrier + ' · ' + smsc.country + ' · ' + smsc.protocol + ' · sessions, queue, routing and controlled actions'
        : 'This connection is not in the register.',
      crumbs: ['Connectivity', { label: 'SMSCs', to: '/smscs' }, smsc ? smsc.id : id],
      analytical: true,
      render: (p) => <SmscDetailScreen smscId={id} {...p} />,
    };
  }
  if (route.startsWith('/services/')) {
    const name = route.slice('/services/'.length);
    const service = SERVICES.find((s) => s.name === name);
    return {
      title: service ? service.name : 'Service',
      subtitle: service
        ? service.role + ' · root failure or downstream symptom, and the controls that are safe to use'
        : 'This component is not in the register.',
      crumbs: ['System', { label: 'Services', to: '/services' }, service ? service.name : name],
      render: (p) => <ServiceDetailScreen serviceName={name} {...p} />,
    };
  }
  return PAGES[route] || PAGES['/dashboard'];
}

/* Telemetry is honest per screen: the metrics collector restarted recently, so the
   screens that depend on its scrape report delayed rather than live. */
const DELAYED = ['/services', '/nodes', '/performance'];

export function App() {
  const [signedIn, setSignedIn] = React.useState(false);
  const [route, setRoute] = React.useState('/dashboard');
  const [range, setRange] = React.useState('1h');
  const [theme, setTheme] = React.useState('light');

  React.useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  React.useEffect(() => { window.scrollTo(0, 0); }, [route]);

  if (!signedIn) return <LoginScreen onSignIn={() => setSignedIn(true)} />;

  const page = resolve(route);

  return (
    <AppShell
      route={route}
      onNavigate={setRoute}
      range={range}
      onRange={setRange}
      showRange={Boolean(page.analytical)}
      freshness={DELAYED.some((r) => route === r || route.startsWith(r + '/')) ? 'delayed' : 'live'}
      theme={theme}
      onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      onLogout={() => setSignedIn(false)}
      breadcrumbs={page.crumbs}
      title={page.title}
      subtitle={page.subtitle}
    >
      {page.render({ onNavigate: setRoute, range })}
    </AppShell>
  );
}
