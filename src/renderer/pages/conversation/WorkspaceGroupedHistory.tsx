/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/storage';
import FlexFullContainer from '@/renderer/components/FlexFullContainer';
import { CronJobIndicator, useCronJobsMap } from '@/renderer/pages/cron';
import { addEventListener, emitter } from '@/renderer/utils/emitter';
import { getActivityTime, getTimelineLabel } from '@/renderer/utils/timeline';
import { iconColors } from '@/renderer/theme/colors';
import { getWorkspaceDisplayName } from '@/renderer/utils/workspace';
import { getWorkspaceUpdateTime } from '@/renderer/utils/workspaceHistory';
import { Button, Checkbox, Empty, Input, Message, Modal, Popconfirm, Tooltip } from '@arco-design/web-react';
import { Close, DeleteOne, MessageOne, EditOne, SettingTwo } from '@icon-park/react';
import classNames from 'classnames';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useConversationTabs } from './context/ConversationTabsContext';
import WorkspaceCollapse from './WorkspaceCollapse';

interface WorkspaceGroup {
  workspace: string; // 完整路径
  displayName: string; // 显示名称
  conversations: TChatConversation[];
}

// 统一的时间线项目，可以是 workspace 分组或独立会话
interface TimelineItem {
  type: 'workspace' | 'conversation';
  time: number; // 用于排序的时间
  workspaceGroup?: WorkspaceGroup; // type === 'workspace' 时有值
  conversation?: TChatConversation; // type === 'conversation' 时有值
}

interface TimelineSection {
  timeline: string; // 时间线标题
  items: TimelineItem[]; // 合并后按时间排序的项目
}

// Helper to get timeline label for a conversation
const getConversationTimelineLabel = (conversation: TChatConversation, t: (key: string) => string): string => {
  const time = getActivityTime(conversation);
  return getTimelineLabel(time, Date.now(), t);
};

// 按时间线和工作空间分组
const groupConversationsByTimelineAndWorkspace = (conversations: TChatConversation[], t: (key: string) => string): TimelineSection[] => {
  // 第一步：先按workspace分组所有会话
  const allWorkspaceGroups = new Map<string, TChatConversation[]>();
  const withoutWorkspaceConvs: TChatConversation[] = [];

  conversations.forEach((conv) => {
    const workspace = conv.extra?.workspace;
    const customWorkspace = conv.extra?.customWorkspace;

    if (customWorkspace && workspace) {
      if (!allWorkspaceGroups.has(workspace)) {
        allWorkspaceGroups.set(workspace, []);
      }
      allWorkspaceGroups.get(workspace)!.push(conv);
    } else {
      withoutWorkspaceConvs.push(conv);
    }
  });

  // 第二步：为每个workspace组确定它应该出现在哪个时间线（使用组内最新会话的时间）
  const workspaceGroupsByTimeline = new Map<string, WorkspaceGroup[]>();

  allWorkspaceGroups.forEach((convList, workspace) => {
    // 按时间排序会话
    const sortedConvs = convList.sort((a, b) => getActivityTime(b) - getActivityTime(a));
    // 使用最新会话的时间线
    const latestConv = sortedConvs[0];
    const timeline = getConversationTimelineLabel(latestConv, t);

    if (!workspaceGroupsByTimeline.has(timeline)) {
      workspaceGroupsByTimeline.set(timeline, []);
    }

    workspaceGroupsByTimeline.get(timeline)!.push({
      workspace,
      displayName: getWorkspaceDisplayName(workspace),
      conversations: sortedConvs,
    });
  });

  // 第三步：将无workspace的会话按时间线分组
  const withoutWorkspaceByTimeline = new Map<string, TChatConversation[]>();

  withoutWorkspaceConvs.forEach((conv) => {
    const timeline = getConversationTimelineLabel(conv, t);
    if (!withoutWorkspaceByTimeline.has(timeline)) {
      withoutWorkspaceByTimeline.set(timeline, []);
    }
    withoutWorkspaceByTimeline.get(timeline)!.push(conv);
  });

  // 第四步：按时间线顺序构建sections
  const timelineOrder = ['conversation.history.today', 'conversation.history.yesterday', 'conversation.history.recent7Days', 'conversation.history.earlier'];
  const sections: TimelineSection[] = [];

  timelineOrder.forEach((timelineKey) => {
    const timeline = t(timelineKey);
    const withWorkspace = workspaceGroupsByTimeline.get(timeline) || [];
    const withoutWorkspace = withoutWorkspaceByTimeline.get(timeline) || [];

    // 只有当该时间线有会话时才添加section
    if (withWorkspace.length === 0 && withoutWorkspace.length === 0) return;

    // 将 workspace 分组和独立会话合并成统一的 items 数组
    const items: TimelineItem[] = [];

    // 添加 workspace 分组项目
    withWorkspace.forEach((group) => {
      const updateTime = getWorkspaceUpdateTime(group.workspace);
      const time = updateTime > 0 ? updateTime : getActivityTime(group.conversations[0]);
      items.push({
        type: 'workspace',
        time,
        workspaceGroup: group,
      });
    });

    // 添加独立会话项目
    withoutWorkspace.forEach((conv) => {
      items.push({
        type: 'conversation',
        time: getActivityTime(conv),
        conversation: conv,
      });
    });

    // 按时间统一排序（最近的在前）
    items.sort((a, b) => b.time - a.time);

    sections.push({
      timeline,
      items,
    });
  });

  return sections;
};

const EXPANSION_STORAGE_KEY = 'aionui_workspace_expansion';

// Reserved height for the batch mode bottom panel (padding, text, buttons)
const BATCH_PANEL_RESERVED_HEIGHT = 96;

/**
 * Compute range selection between an anchor and a target within an ordered list.
 * Returns the slice of IDs from anchor to target (inclusive), or null if either is missing.
 */
const computeRangeSelection = (order: string[], anchorId: string | null, targetId: string): string[] | null => {
  const anchor = anchorId || targetId;
  const anchorIndex = order.indexOf(anchor);
  const currentIndex = order.indexOf(targetId);
  if (anchorIndex === -1 || currentIndex === -1) return null;
  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  return order.slice(start, end + 1);
};

const WorkspaceGroupedHistory: React.FC<{ onSessionClick?: () => void; collapsed?: boolean }> = ({ onSessionClick, collapsed = false }) => {
  const [conversations, setConversations] = useState<TChatConversation[]>([]);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<string[]>(() => {
    // 从 localStorage 恢复展开状态
    try {
      const stored = localStorage.getItem(EXPANSION_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      // 忽略错误
    }
    return [];
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [batchMode, setBatchMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [batchDeleteModalVisible, setBatchDeleteModalVisible] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { openTab, closeAllTabs, activeTab, updateTabName } = useConversationTabs();
  const { getJobStatus, markAsRead } = useCronJobsMap();

  // 加载会话列表
  useEffect(() => {
    const refresh = () => {
      ipcBridge.database.getUserConversations
        .invoke({ page: 0, pageSize: 10000 })
        .then((data) => {
          if (data && Array.isArray(data)) {
            setConversations(data);
          } else {
            setConversations([]);
          }
        })
        .catch((error) => {
          console.error('[WorkspaceGroupedHistory] Failed to load conversations:', error);
          setConversations([]);
        });
    };
    refresh();
    return addEventListener('chat.history.refresh', refresh);
  }, []);

  // Scroll to active conversation when route changes
  useEffect(() => {
    if (!id) return;
    // Use requestAnimationFrame to ensure DOM is updated
    const rafId = requestAnimationFrame(() => {
      const element = document.getElementById('c-' + id);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [id]);

  // 持久化展开状态
  useEffect(() => {
    try {
      localStorage.setItem(EXPANSION_STORAGE_KEY, JSON.stringify(expandedWorkspaces));
    } catch {
      // 忽略错误
    }
  }, [expandedWorkspaces]);

  // 按时间线和workspace分组
  const timelineSections = useMemo(() => {
    return groupConversationsByTimelineAndWorkspace(conversations, t);
  }, [conversations, t]);

  const allConversationIds = useMemo(() => conversations.map((item) => item.id), [conversations]);
  const selectedConversationIdSet = useMemo(() => new Set(selectedConversationIds), [selectedConversationIds]);
  const hasSelection = selectedConversationIdSet.size > 0;
  const selectedConversations = useMemo(() => {
    if (!hasSelection) return [];
    return conversations.filter((conv) => selectedConversationIdSet.has(conv.id));
  }, [conversations, hasSelection, selectedConversationIdSet]);
  const visibleConversationOrder = useMemo(() => {
    const ids: string[] = [];
    timelineSections.forEach((section) => {
      section.items.forEach((item) => {
        if (item.type === 'workspace' && item.workspaceGroup) {
          if (!expandedWorkspaces.includes(item.workspaceGroup.workspace)) return;
          item.workspaceGroup.conversations.forEach((conv) => ids.push(conv.id));
          return;
        }
        if (item.type === 'conversation' && item.conversation) {
          ids.push(item.conversation.id);
        }
      });
    });
    return ids;
  }, [timelineSections, expandedWorkspaces]);

  useEffect(() => {
    if (!batchMode) return;
    const allIdsSet = new Set(allConversationIds);
    setSelectedConversationIds((prev) => prev.filter((convId) => allIdsSet.has(convId)));
  }, [batchMode, allConversationIds]);

  // 默认展开所有 workspace（仅在还未记录展开状态时执行一次）
  useEffect(() => {
    if (expandedWorkspaces.length > 0) return;
    const allWorkspaces: string[] = [];
    timelineSections.forEach((section) => {
      section.items.forEach((item) => {
        if (item.type === 'workspace' && item.workspaceGroup) {
          allWorkspaces.push(item.workspaceGroup.workspace);
        }
      });
    });
    if (allWorkspaces.length > 0) {
      setExpandedWorkspaces(allWorkspaces);
    }
  }, [timelineSections, expandedWorkspaces.length]);

  const handleConversationClick = useCallback(
    (conv: TChatConversation) => {
      const customWorkspace = conv.extra?.customWorkspace;
      const newWorkspace = conv.extra?.workspace;

      // Mark conversation as read (clear unread cron execution indicator)
      markAsRead(conv.id);

      // 如果点击的是非自定义工作空间的会话，关闭所有tabs
      if (!customWorkspace) {
        closeAllTabs();
        void navigate(`/conversation/${conv.id}`);
        if (onSessionClick) {
          onSessionClick();
        }
        return;
      }

      // 如果点击的是自定义工作空间的会话
      // 检查当前活动tab的workspace是否与新会话的workspace不同
      const currentWorkspace = activeTab?.workspace;

      // 如果当前没有活动tab，或者workspace不同，则关闭所有tabs后再打开新tab
      if (!currentWorkspace || currentWorkspace !== newWorkspace) {
        closeAllTabs();
      }

      // 打开新会话的tab
      openTab(conv);
      void navigate(`/conversation/${conv.id}`);
      if (onSessionClick) {
        onSessionClick();
      }
    },
    [openTab, closeAllTabs, activeTab, navigate, onSessionClick, markAsRead]
  );

  // 切换 workspace 展开/收起状态
  const handleToggleWorkspace = useCallback((workspace: string) => {
    setExpandedWorkspaces((prev) => {
      if (prev.includes(workspace)) {
        return prev.filter((w) => w !== workspace);
      } else {
        return [...prev, workspace];
      }
    });
  }, []);

  const handleRemoveConversation = useCallback(
    (convId: string) => {
      void ipcBridge.conversation.remove
        .invoke({ id: convId })
        .then((success) => {
          if (success) {
            // 触发会话删除事件，用于关闭对应的 tab
            // Trigger conversation deletion event to close corresponding tab
            emitter.emit('conversation.deleted', convId);
            // 刷新会话列表
            emitter.emit('chat.history.refresh');
            if (id === convId) {
              void navigate('/');
            }
          }
        })
        .catch((error) => {
          console.error('Failed to remove conversation:', error);
        });
    },
    [id, navigate]
  );

  const handleEditStart = useCallback((conversation: TChatConversation) => {
    setEditingId(conversation.id);
    setEditingName(conversation.name);
  }, []);

  const handleEditSave = useCallback(async () => {
    if (!editingId || !editingName.trim()) return;

    try {
      const success = await ipcBridge.conversation.update.invoke({
        id: editingId,
        updates: { name: editingName.trim() },
      });

      if (success) {
        updateTabName(editingId, editingName.trim());
        emitter.emit('chat.history.refresh');
      }
    } catch (error) {
      console.error('Failed to update conversation name:', error);
    } finally {
      setEditingId(null);
      setEditingName('');
    }
  }, [editingId, editingName, updateTabName]);

  const handleEditCancel = useCallback(() => {
    setEditingId(null);
    setEditingName('');
  }, []);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void handleEditSave();
      } else if (e.key === 'Escape') {
        handleEditCancel();
      }
    },
    [handleEditSave, handleEditCancel]
  );

  const handleToggleBatchMode = useCallback(() => {
    setBatchMode((prev) => {
      const next = !prev;
      if (next) {
        setEditingId(null);
        setEditingName('');
      } else {
        setSelectedConversationIds([]);
        setSelectionAnchorId(null);
        setBatchDeleteModalVisible(false);
      }
      return next;
    });
  }, []);

  const handleToggleConversationSelection = useCallback((conversationId: string) => {
    setSelectedConversationIds((prev) => {
      if (prev.includes(conversationId)) {
        return prev.filter((idItem) => idItem !== conversationId);
      }
      return [...prev, conversationId];
    });
    setSelectionAnchorId(conversationId);
  }, []);

  const handleConversationRowClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>, conversation: TChatConversation) => {
      const isMultiSelectGesture = event.ctrlKey || event.metaKey;
      const isRangeSelectGesture = event.shiftKey;

      const openBatchModeIfNeeded = () => {
        if (!batchMode) {
          setBatchMode(true);
          setEditingId(null);
          setEditingName('');
        }
      };

      if (isRangeSelectGesture) {
        openBatchModeIfNeeded();
        const order = visibleConversationOrder.length > 0 ? visibleConversationOrder : allConversationIds;
        const rangeIds = computeRangeSelection(order, selectionAnchorId, conversation.id);

        if (!rangeIds) {
          setSelectedConversationIds([conversation.id]);
          setSelectionAnchorId(conversation.id);
          return;
        }

        setSelectedConversationIds((prev) => {
          if (isMultiSelectGesture) {
            return Array.from(new Set([...prev, ...rangeIds]));
          }
          return rangeIds;
        });
        if (!selectionAnchorId) {
          setSelectionAnchorId(conversation.id);
        }
        return;
      }

      if (isMultiSelectGesture) {
        openBatchModeIfNeeded();
        handleToggleConversationSelection(conversation.id);
        return;
      }

      handleConversationClick(conversation);
    },
    [batchMode, visibleConversationOrder, allConversationIds, selectionAnchorId, handleToggleConversationSelection, handleConversationClick]
  );

  const handleSelectAll = useCallback(() => {
    setSelectedConversationIds(allConversationIds);
    setSelectionAnchorId(allConversationIds[0] || null);
  }, [allConversationIds]);

  const handleClearSelection = useCallback(() => {
    setSelectedConversationIds([]);
    setSelectionAnchorId(null);
  }, []);

  const handleBatchDelete = useCallback(async () => {
    if (!hasSelection) return;
    try {
      setBatchDeleting(true);
      const { successIds, failedIds } = await ipcBridge.conversation.removeBatch.invoke({ ids: selectedConversationIds });

      successIds.forEach((conversationId) => emitter.emit('conversation.deleted', conversationId));

      if (successIds.length > 0) {
        emitter.emit('chat.history.refresh');
      }
      if (id && successIds.includes(id)) {
        void navigate('/');
      }

      if (failedIds.length > 0) {
        Message.warning(t('conversation.history.batchDeletePartial', { success: successIds.length, failed: failedIds.length }));
      } else if (successIds.length > 0) {
        Message.success(t('conversation.history.batchDeleteSuccess', { count: successIds.length }));
      }

      setSelectedConversationIds([]);
      setSelectionAnchorId(null);
      setBatchDeleteModalVisible(false);
      setBatchMode(false);
    } catch (error) {
      console.error('[WorkspaceGroupedHistory] Failed to batch delete conversations:', error);
      Message.error(t('conversation.history.batchDeleteFailed'));
      setBatchDeleteModalVisible(false);
    } finally {
      setBatchDeleting(false);
    }
  }, [hasSelection, selectedConversationIds, id, navigate, t]);

  const renderConversation = useCallback(
    (conversation: TChatConversation) => {
      const isSelected = id === conversation.id;
      const isEditing = editingId === conversation.id;
      const cronStatus = getJobStatus(conversation.id);
      const isChecked = selectedConversationIdSet.has(conversation.id);
      const isItemActive = isSelected || (batchMode && isChecked);

      return (
        <Tooltip key={conversation.id} disabled={!collapsed} content={conversation.name || t('conversation.welcome.newConversation')} position='right'>
          <div
            id={'c-' + conversation.id}
            className={classNames('chat-history__item hover:bg-hover px-12px py-8px rd-8px flex justify-start items-center group cursor-pointer relative overflow-hidden shrink-0 conversation-item [&.conversation-item+&.conversation-item]:mt-2px min-w-0', {
              '!bg-active': isItemActive,
            })}
            onClick={(event) => {
              handleConversationRowClick(event, conversation);
            }}
          >
            {batchMode && (
              <span
                className='mr-6px flex-shrink-0'
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.shiftKey) {
                    const order = visibleConversationOrder.length > 0 ? visibleConversationOrder : allConversationIds;
                    const rangeIds = computeRangeSelection(order, selectionAnchorId, conversation.id);
                    if (!rangeIds) {
                      setSelectedConversationIds([conversation.id]);
                      setSelectionAnchorId(conversation.id);
                      return;
                    }
                    setSelectedConversationIds(rangeIds);
                    if (!selectionAnchorId) {
                      setSelectionAnchorId(conversation.id);
                    }
                    return;
                  }
                  handleToggleConversationSelection(conversation.id);
                }}
              >
                <Checkbox checked={isChecked} onChange={() => {}} />
              </span>
            )}
            {cronStatus !== 'none' ? <CronJobIndicator status={cronStatus} size={20} className='flex-shrink-0' /> : <MessageOne theme='outline' size='20' className='line-height-0 flex-shrink-0' />}
            <FlexFullContainer className='h-24px min-w-0 flex-1 collapsed-hidden ml-10px'>{isEditing ? <Input className='chat-history__item-editor text-14px lh-24px h-24px w-full' value={editingName} onChange={setEditingName} onKeyDown={handleEditKeyDown} onBlur={handleEditSave} autoFocus size='small' /> : <div className='chat-history__item-name overflow-hidden text-ellipsis inline-block flex-1 text-14px lh-24px whitespace-nowrap min-w-0'>{conversation.name}</div>}</FlexFullContainer>
            {!isEditing && !batchMode && (
              <div
                className={classNames('absolute right-0px top-0px h-full w-70px items-center justify-end hidden group-hover:flex !collapsed-hidden pr-12px')}
                style={{
                  backgroundImage: isItemActive ? `linear-gradient(to right, transparent, var(--aou-2) 50%)` : `linear-gradient(to right, transparent, var(--aou-1) 50%)`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                <span
                  className='flex-center mr-8px'
                  onClick={(event) => {
                    event.stopPropagation();
                    handleEditStart(conversation);
                  }}
                >
                  <EditOne theme='outline' size='20' className='flex' />
                </span>
                <Popconfirm
                  title={t('conversation.history.deleteTitle')}
                  content={t('conversation.history.deleteConfirm')}
                  okText={t('conversation.history.confirmDelete')}
                  cancelText={t('conversation.history.cancelDelete')}
                  onOk={(event) => {
                    event.stopPropagation();
                    handleRemoveConversation(conversation.id);
                  }}
                  onCancel={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <span
                    className='flex-center'
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <DeleteOne theme='outline' size='20' className='flex' />
                  </span>
                </Popconfirm>
              </div>
            )}
          </div>
        </Tooltip>
      );
    },
    [id, collapsed, editingId, editingName, t, batchMode, selectedConversationIdSet, visibleConversationOrder, allConversationIds, selectionAnchorId, handleConversationRowClick, handleToggleConversationSelection, handleEditStart, handleEditKeyDown, handleEditSave, handleRemoveConversation, getJobStatus]
  );

  // 如果没有任何会话，显示空状态
  if (timelineSections.length === 0) {
    return (
      <FlexFullContainer>
        <div className='flex-center'>
          <Empty description={t('conversation.history.noHistory')} />
        </div>
      </FlexFullContainer>
    );
  }

  return (
    <FlexFullContainer>
      <div
        className='size-full overflow-y-auto overflow-x-hidden'
        style={{
          paddingBottom: batchMode && !collapsed ? BATCH_PANEL_RESERVED_HEIGHT : undefined,
        }}
      >
        {timelineSections.map((section, sectionIndex) => (
          <div key={section.timeline} className='mb-8px min-w-0'>
            {/* 时间线标题 */}
            {!collapsed && (
              <div className='chat-history__section group px-12px py-8px text-13px text-t-secondary font-bold flex items-center justify-between gap-8px relative'>
                <span className='pr-28px'>{section.timeline}</span>
                {sectionIndex === 0 && !batchMode && (
                  <div className='absolute right-12px top-50% -translate-y-50% opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'>
                    <Tooltip content={t('conversation.history.batchManageTooltip')} position='left'>
                      <Button type='text' size='mini' className='!w-28px !h-28px !min-w-28px !p-0 !rd-50% flex-center hover:bg-hover' onClick={handleToggleBatchMode}>
                        <SettingTwo theme='outline' size='16' className='flex' />
                      </Button>
                    </Tooltip>
                  </div>
                )}
              </div>
            )}

            {/* 按时间统一排序渲染所有项目（workspace 分组和独立会话混合） */}
            {section.items.map((item) => {
              if (item.type === 'workspace' && item.workspaceGroup) {
                const group = item.workspaceGroup;
                return (
                  <div key={group.workspace} className={classNames('min-w-0', { 'px-8px': !collapsed })}>
                    <WorkspaceCollapse
                      expanded={expandedWorkspaces.includes(group.workspace)}
                      onToggle={() => handleToggleWorkspace(group.workspace)}
                      siderCollapsed={collapsed}
                      header={
                        <div className='flex items-center gap-8px text-14px min-w-0'>
                          <span className='font-medium truncate flex-1 text-t-primary min-w-0'>{group.displayName}</span>
                        </div>
                      }
                    >
                      <div className={classNames('flex flex-col gap-2px min-w-0', { 'mt-4px': !collapsed })}>{group.conversations.map((conv) => renderConversation(conv))}</div>
                    </WorkspaceCollapse>
                  </div>
                );
              } else if (item.type === 'conversation' && item.conversation) {
                return renderConversation(item.conversation);
              }
              return null;
            })}
          </div>
        ))}
      </div>
      {batchMode && !collapsed && (
        <div className='batch-panel absolute left-8px right-8px bottom-8px px-12px py-10px rd-10px border border-color-secondary bg-dialog-fill-0'>
          <div className='flex items-center justify-between gap-8px mb-8px'>
            <div className='text-14px lh-20px text-t-primary font-medium'>{t('conversation.history.batchManageTitle')}</div>
            <Button type='text' size='mini' className='!w-28px !h-28px !min-w-28px !p-0 !rd-50% inline-flex items-center justify-center hover:bg-hover' onClick={handleToggleBatchMode} aria-label={t('conversation.history.batchDone')}>
              <Close theme='outline' size={16} fill={iconColors.secondary} className='flex' />
            </Button>
          </div>
          <div className='text-12px lh-18px text-t-secondary mb-4px'>{t('conversation.history.batchSelected', { count: selectedConversationIds.length })}</div>
          <div className='text-11px lh-16px text-t-tertiary mb-8px'>{t('conversation.history.batchModeHint')}</div>
          <div className='grid grid-cols-2 gap-6px'>
            <Button type='secondary' size='small' className='!rd-100px' onClick={selectedConversationIdSet.size === allConversationIds.length ? handleClearSelection : handleSelectAll}>
              {selectedConversationIdSet.size === allConversationIds.length ? t('conversation.history.clearSelection') : t('conversation.history.selectAll')}
            </Button>
            <Button type='primary' size='small' status='danger' className='!rd-100px' disabled={!hasSelection} onClick={() => setBatchDeleteModalVisible(true)}>
              {t('conversation.history.batchDelete')}
            </Button>
          </div>
        </div>
      )}
      <Modal
        visible={batchDeleteModalVisible}
        title={t('conversation.history.batchDeleteTitle')}
        className='batch-delete-modal w-[90vw] md:w-[560px]'
        onCancel={() => {
          if (batchDeleting) return;
          setBatchDeleteModalVisible(false);
        }}
        footer={
          <div className='flex justify-end gap-12px'>
            <Button type='secondary' size='large' onClick={() => setBatchDeleteModalVisible(false)} disabled={batchDeleting}>
              {t('common.cancel')}
            </Button>
            <Button type='outline' status='danger' size='large' onClick={() => void handleBatchDelete()} loading={batchDeleting} disabled={!hasSelection}>
              {t('common.delete')}
            </Button>
          </div>
        }
        style={{ borderRadius: '12px' }}
        alignCenter
        getPopupContainer={() => document.body}
      >
        <div className='text-14px lh-22px text-t-secondary mb-10px'>{t('conversation.history.batchDeleteModalDesc', { count: selectedConversations.length })}</div>
        <div className='max-h-220px overflow-y-auto rd-8px border border-color-secondary bg-fill-0 px-12px py-10px'>
          {selectedConversations.slice(0, 10).map((conv) => (
            <div key={conv.id} className='text-14px lh-24px text-t-primary truncate'>
              • {conv.name || t('conversation.welcome.newConversation')}
            </div>
          ))}
          {selectedConversations.length > 10 && <div className='text-12px lh-20px text-t-secondary mt-6px'>{t('conversation.history.batchDeleteMore', { count: selectedConversations.length - 10 })}</div>}
        </div>
      </Modal>
    </FlexFullContainer>
  );
};

export default WorkspaceGroupedHistory;
