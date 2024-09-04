import { MemoryHistoryBuildOptions } from 'history';
import { ComponentProps, ReactNode } from 'react';
import { render, screen, userEvent, waitFor, waitForElementToBeRemoved } from 'test/test-utils';

import { selectors } from '@grafana/e2e-selectors';
import {
  testWithFeatureToggles,
  testWithLicenseFeatures,
} from 'app/features/alerting/unified/utils/alerting-test-utils';
import { AlertManagerDataSourceJsonData, AlertManagerImplementation } from 'app/plugins/datasource/alertmanager/types';
import { AccessControlAction } from 'app/types';

import { setupMswServer } from '../../mockApi';
import { grantUserPermissions, mockDataSource } from '../../mocks';
import { AlertmanagerProvider } from '../../state/AlertmanagerContext';
import { setupDataSources } from '../../testSetup/datasources';
import { DataSourceType, GRAFANA_RULES_SOURCE_NAME } from '../../utils/datasource';

import { ContactPoint } from './ContactPoint';
import ContactPointsPageContents from './ContactPoints';
import setupMimirFlavoredServer, { MIMIR_DATASOURCE_UID } from './__mocks__/mimirFlavoredServer';
import setupVanillaAlertmanagerFlavoredServer, {
  VANILLA_ALERTMANAGER_DATASOURCE_UID,
} from './__mocks__/vanillaAlertmanagerServer';
import { ContactPointWithMetadata, RouteReference } from './utils';

/**
 * There are lots of ways in which we test our pages and components. Here's my opinionated approach to testing them.
 *
 *  Use MSW to mock API responses, you can copy the JSON results from the network panel and use them in a __mocks__ folder.
 *
 * 1. Make sure we have "presentation" components we can test without mocking data,
 *    test these if they have some logic in them (hiding / showing things) and sad paths.
 *
 * 2. For testing the "container" components, check if data fetching is working as intended (you can use loading state)
 *    and check if we're not in an error state (although you can test for that too for sad path).
 *
 * 3. Write tests for the hooks we call in the "container" components
 *    if those have any logic or data structure transformations in them.
 *
 * ⚠️ Always set up the MSW server only once – MWS does not support multiple calls to setupServer(); and causes all sorts of weird issues
 */
const server = setupMswServer();

const renderWithProvider = (
  children: ReactNode,
  historyOptions?: MemoryHistoryBuildOptions,
  providerProps?: Partial<ComponentProps<typeof AlertmanagerProvider>>
) =>
  render(
    <AlertmanagerProvider accessType="notification" {...providerProps}>
      {children}
    </AlertmanagerProvider>,
    { historyOptions }
  );

const basicContactPoint: ContactPointWithMetadata = {
  name: 'my-contact-point',
  id: 'foo',
  grafana_managed_receiver_configs: [],
};

const clickMoreActionsButton = async (name: string) => {
  const user = userEvent.setup();
  const moreActions = await screen.findByRole('button', { name: `More actions for contact point "${name}"` });
  await user.click(moreActions);
};

const attemptDeleteContactPoint = async (name: string) => {
  const user = userEvent.setup();

  await clickMoreActionsButton(name);

  const deleteButton = screen.getByRole('menuitem', { name: /delete/i });
  await user.click(deleteButton);

  await screen.findByRole('heading', { name: /delete contact point/i });
  return user.click(await screen.findByRole('button', { name: /delete contact point/i }));
};

describe('contact points', () => {
  describe('Contact points with Grafana managed alertmanager', () => {
    beforeEach(() => {
      grantUserPermissions([
        AccessControlAction.AlertingNotificationsRead,
        AccessControlAction.AlertingNotificationsWrite,
      ]);
    });

    describe('tabs behaviour', () => {
      test('loads contact points tab', async () => {
        renderWithProvider(<ContactPointsPageContents />, { initialEntries: ['/?tab=contact_points'] });

        expect(await screen.findByText(/add contact point/i)).toBeInTheDocument();
      });

      test('loads templates tab', async () => {
        renderWithProvider(<ContactPointsPageContents />, { initialEntries: ['/?tab=templates'] });

        expect(await screen.findByText(/add notification template/i)).toBeInTheDocument();
      });

      test('defaults to contact points tab with invalid query param', async () => {
        renderWithProvider(<ContactPointsPageContents />, { initialEntries: ['/?tab=foo_bar'] });

        expect(await screen.findByText(/add contact point/i)).toBeInTheDocument();
      });

      test('defaults to contact points tab with no query param', async () => {
        renderWithProvider(<ContactPointsPageContents />);

        expect(await screen.findByText(/add contact point/i)).toBeInTheDocument();
      });
    });

    it('should show / hide loading states, have all actions enabled', async () => {
      renderWithProvider(<ContactPointsPageContents />);

      await waitForElementToBeRemoved(screen.queryByText('Loading...'));
      expect(screen.queryByTestId(selectors.components.Alert.alertV2('error'))).not.toBeInTheDocument();

      expect(screen.getByText('grafana-default-email')).toBeInTheDocument();
      expect(screen.getAllByTestId('contact-point')).toHaveLength(5);

      // check for available actions – our mock 4 contact points, 1 of them is provisioned
      expect(screen.getByRole('link', { name: 'add contact point' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'export all' })).toBeInTheDocument();

      // 2 of them are unused by routes in the mock response
      const unusedBadge = screen.getAllByLabelText('unused');
      expect(unusedBadge).toHaveLength(3);

      const viewProvisioned = screen.getByRole('link', { name: 'view-action' });
      expect(viewProvisioned).toBeInTheDocument();
      expect(viewProvisioned).toBeEnabled();

      const editButtons = screen.getAllByRole('link', { name: 'edit-action' });
      expect(editButtons).toHaveLength(4);
      editButtons.forEach((button) => {
        expect(button).toBeEnabled();
      });

      const moreActionsButtons = screen.getAllByRole('button', { name: /More/ });
      expect(moreActionsButtons).toHaveLength(5);
      moreActionsButtons.forEach((button) => {
        expect(button).toBeEnabled();
      });
    });

    it('should disable certain actions if the user has no write permissions', async () => {
      grantUserPermissions([AccessControlAction.AlertingNotificationsRead]);

      const { user } = renderWithProvider(<ContactPointsPageContents />);

      // wait for loading to be done
      await waitForElementToBeRemoved(screen.queryByText('Loading...'));

      // should disable create contact point
      expect(screen.getByRole('link', { name: 'add contact point' })).toHaveAttribute('aria-disabled', 'true');

      // there should be no edit buttons
      expect(screen.queryAllByRole('link', { name: 'edit-action' })).toHaveLength(0);

      // there should be view buttons though
      const viewButtons = screen.getAllByRole('link', { name: 'view-action' });
      expect(viewButtons).toHaveLength(5);

      // delete should be disabled in the "more" actions
      const moreButtons = screen.queryAllByRole('button', { name: /More/ });
      expect(moreButtons).toHaveLength(5);

      // check if all of the delete buttons are disabled
      for await (const button of moreButtons) {
        await user.click(button);
        const deleteButton = screen.queryByRole('menuitem', { name: 'delete' });
        expect(deleteButton).toBeDisabled();
        // click outside the menu to close it otherwise we can't interact with the rest of the page
        await user.click(document.body);
      }

      // check buttons in Notification Templates
      const notificationTemplatesTab = screen.getByRole('tab', { name: 'Notification Templates' });
      await user.click(notificationTemplatesTab);
      expect(screen.getByRole('link', { name: 'Add notification template' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('allows deleting when not disabled', async () => {
      renderWithProvider(
        <ContactPointsPageContents />,
        { initialEntries: ['/?tab=contact_points'] },
        { alertmanagerSourceName: GRAFANA_RULES_SOURCE_NAME }
      );

      await attemptDeleteContactPoint('lotsa-emails');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('should disable edit button', async () => {
      renderWithProvider(<ContactPoint contactPoint={basicContactPoint} disabled={true} />);

      const moreActions = screen.getByRole('button', { name: /More/ });
      expect(moreActions).toBeEnabled();

      const editAction = screen.getByTestId('edit-action');
      expect(editAction).toHaveAttribute('aria-disabled', 'true');
    });

    it('should disable buttons when provisioned', async () => {
      const { user } = renderWithProvider(<ContactPoint contactPoint={{ ...basicContactPoint, provisioned: true }} />);

      expect(screen.getByText(/provisioned/i)).toBeInTheDocument();

      const editAction = screen.queryByTestId('edit-action');
      expect(editAction).not.toBeInTheDocument();

      const viewAction = screen.getByRole('link', { name: /view/i });
      expect(viewAction).toBeInTheDocument();

      const moreActions = screen.getByRole('button', { name: /More/ });
      expect(moreActions).toBeEnabled();
      await user.click(moreActions);

      const deleteButton = screen.getByRole('menuitem', { name: /delete/i });
      expect(deleteButton).toBeDisabled();
    });

    it('should disable delete when contact point is linked to at least one normal notification policy', async () => {
      const policies: RouteReference[] = [
        {
          receiver: 'my-contact-point',
          route: {
            type: 'normal',
          },
        },
      ];

      const { user } = renderWithProvider(<ContactPoint contactPoint={{ ...basicContactPoint, policies }} />);

      expect(screen.getByRole('link', { name: /1 notification policy/ })).toBeInTheDocument();

      const moreActions = screen.getByRole('button', { name: /More/ });
      await user.click(moreActions);

      const deleteButton = screen.getByRole('menuitem', { name: /delete/i });
      expect(deleteButton).toBeDisabled();
    });

    it('should not disable delete when contact point is linked only to auto-generated notification policy', async () => {
      const policies: RouteReference[] = [
        {
          receiver: 'my-contact-point',
          route: {
            type: 'auto-generated',
          },
        },
      ];

      const { user } = renderWithProvider(<ContactPoint contactPoint={{ ...basicContactPoint, policies }} />);

      const moreActions = screen.getByRole('button', { name: /More/ });
      await user.click(moreActions);

      const deleteButton = screen.getByRole('menuitem', { name: /delete/i });
      expect(deleteButton).toBeEnabled();
    });

    it('should be able to search', async () => {
      const { user } = renderWithProvider(<ContactPointsPageContents />);

      const searchInput = await screen.findByRole('textbox', { name: 'search contact points' });
      await user.type(searchInput, 'slack');
      expect(searchInput).toHaveValue('slack');

      expect(await screen.findByText('Slack with multiple channels')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getAllByTestId('contact-point')).toHaveLength(1);
      });

      // ⚠️ for some reason, the query params are preserved for all tests so don't forget to clear the input
      const clearButton = screen.getByRole('button', { name: 'clear' });
      await user.click(clearButton);
      expect(searchInput).toHaveValue('');
    });
  });

  describe('Contact points with Mimir-flavored alertmanager', () => {
    beforeEach(() => {
      setupMimirFlavoredServer(server);
    });

    beforeAll(() => {
      grantUserPermissions([
        AccessControlAction.AlertingNotificationsExternalRead,
        AccessControlAction.AlertingNotificationsExternalWrite,
      ]);
      setupDataSources(
        mockDataSource({
          type: DataSourceType.Alertmanager,
          name: MIMIR_DATASOURCE_UID,
          uid: MIMIR_DATASOURCE_UID,
        })
      );
    });

    it('should show / hide loading states, have the right actions enabled', async () => {
      renderWithProvider(<ContactPointsPageContents />, undefined, { alertmanagerSourceName: MIMIR_DATASOURCE_UID });

      await waitForElementToBeRemoved(screen.queryByText('Loading...'));
      expect(screen.queryByTestId(selectors.components.Alert.alertV2('error'))).not.toBeInTheDocument();

      expect(screen.getByText('mixed')).toBeInTheDocument();
      expect(screen.getByText('some webhook')).toBeInTheDocument();
      expect(screen.getAllByTestId('contact-point')).toHaveLength(2);

      // check for available actions – export should be disabled
      expect(screen.getByRole('link', { name: 'add contact point' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'export all' })).not.toBeInTheDocument();

      // 1 of them is used by a route in the mock response
      const unusedBadge = screen.getAllByLabelText('unused');
      expect(unusedBadge).toHaveLength(1);

      const editButtons = screen.getAllByRole('link', { name: 'edit-action' });
      expect(editButtons).toHaveLength(2);
      editButtons.forEach((button) => {
        expect(button).toBeEnabled();
      });

      const moreActionsButtons = screen.getAllByRole('button', { name: /More/ });
      expect(moreActionsButtons).toHaveLength(2);
      moreActionsButtons.forEach((button) => {
        expect(button).toBeEnabled();
      });
    });
  });

  describe('Vanilla Alertmanager ', () => {
    beforeEach(() => {
      setupVanillaAlertmanagerFlavoredServer(server);
      grantUserPermissions([
        AccessControlAction.AlertingNotificationsExternalRead,
        AccessControlAction.AlertingNotificationsExternalWrite,
      ]);

      const alertManager = mockDataSource<AlertManagerDataSourceJsonData>({
        name: VANILLA_ALERTMANAGER_DATASOURCE_UID,
        uid: VANILLA_ALERTMANAGER_DATASOURCE_UID,
        type: DataSourceType.Alertmanager,
        jsonData: {
          implementation: AlertManagerImplementation.prometheus,
          handleGrafanaManagedAlerts: true,
        },
      });

      setupDataSources(alertManager);
    });

    it("should not allow any editing because it's not supported", async () => {
      const { user } = renderWithProvider(<ContactPointsPageContents />, undefined, {
        alertmanagerSourceName: VANILLA_ALERTMANAGER_DATASOURCE_UID,
      });

      await waitForElementToBeRemoved(screen.queryByText('Loading...'));
      expect(screen.queryByTestId(selectors.components.Alert.alertV2('error'))).not.toBeInTheDocument();

      expect(screen.queryByRole('link', { name: 'add contact point' })).not.toBeInTheDocument();

      const viewProvisioned = screen.getByRole('link', { name: 'view-action' });
      expect(viewProvisioned).toBeInTheDocument();
      expect(viewProvisioned).toBeEnabled();

      // check buttons in Notification Templates
      const notificationTemplatesTab = screen.getByRole('tab', { name: 'Notification Templates' });
      await user.click(notificationTemplatesTab);
      expect(screen.queryByRole('link', { name: 'Add notification template' })).not.toBeInTheDocument();
    });
  });

  describe('alertingApiServer enabled', () => {
    testWithFeatureToggles(['alertingApiServer']);

    beforeEach(() => {
      grantUserPermissions([
        AccessControlAction.AlertingNotificationsRead,
        AccessControlAction.AlertingNotificationsWrite,
      ]);
    });

    const renderGrafanaContactPoints = () =>
      renderWithProvider(
        <ContactPointsPageContents />,
        { initialEntries: ['/?tab=contact_points'] },
        { alertmanagerSourceName: GRAFANA_RULES_SOURCE_NAME }
      );

    it('renders list view correctly', async () => {
      renderGrafanaContactPoints();
      // Check for a specific contact point that we expect to exist in the mock AM config/k8s response
      expect(await screen.findByRole('heading', { name: 'lotsa-emails' })).toBeInTheDocument();
    });

    it('allows deleting', async () => {
      renderGrafanaContactPoints();

      await attemptDeleteContactPoint('lotsa-emails');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not allow deletion of provisioned contact points', async () => {
      renderGrafanaContactPoints();

      return expect(attemptDeleteContactPoint('provisioned-contact-point')).rejects.toBeTruthy();
    });

    describe('accesscontrol license feature enabled', () => {
      testWithLicenseFeatures(['accesscontrol']);

      it('shows manage permissions', async () => {
        // Stub out console.error due to act warnings that I can't get to the bottom of right now
        // When rendering the ManagePermissions logic in a button that isn't in a dropdown,
        // it will render without any console errors, but showing inside a dropdown causes act warnings
        // for some reason
        // TODO: Work out why, and remove the console.error logic here
        const originalConsoleError = console.error;
        jest.spyOn(console, 'error').mockImplementation((msg) => {
          if (/Warning: An update to (.*) inside a test was not wrapped in act/.test(msg)) {
            return;
          }
          originalConsoleError(msg);
          return;
        });

        const { user } = renderGrafanaContactPoints();

        clickMoreActionsButton('lotsa-emails');
        await user.click(await screen.findByRole('menuitem', { name: /manage permissions/i }));
        // await user.click((await screen.findAllByRole('button', { name: /manage permissions/i }))[1]);
        expect(await screen.findByRole('dialog', { name: /drawer title manage permissions/i })).toBeInTheDocument();
        expect(await screen.findByRole('table')).toBeInTheDocument();
      });
    });
  });
});
